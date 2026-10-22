// Plan limits from GET https://api.anthropic.com/api/oauth/usage (read-only).
// The access token is re-read from ~/.claude/.credentials.json every run, is never refreshed or
// written, and never appears in any message or log produced here.
import { readFileSync } from 'node:fs';
import { limitWindowKey, roundIsoToMinute, type LimitSnapshot, type LimitWindow, type UnixSeconds } from '@ccu/shared';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const USAGE_TIMEOUT_MS = 8000;

export type TokenRead = { ok: true; token: string } | { ok: false; error: string };

/** Extracts `claudeAiOauth.accessToken`; refuses an expired token (we never refresh it). */
export function readAccessToken(credentialsFile: string, nowMs = Date.now()): TokenRead {
  let raw: string;
  try {
    raw = readFileSync(credentialsFile, 'utf8');
  } catch {
    return { ok: false, error: 'no credentials file (not logged in with OAuth?)' };
  }
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'credentials file is not valid JSON' };
  }
  const oauth = o?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || !token) return { ok: false, error: 'no OAuth access token in credentials' };
  const exp = Number(oauth.expiresAt);
  if (Number.isFinite(exp) && exp > 0 && exp <= nowMs) return { ok: false, error: 'OAuth token expired (Claude Code refreshes it on next use)' };
  return { ok: true, token };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UsageFetch = { ok: true; body: unknown } | { ok: false; status: number | null; error: string };

export async function fetchUsage(token: string, opts: { fetch?: FetchLike; timeoutMs?: number; userAgent?: string } = {}): Promise<UsageFetch> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': opts.userAgent ?? 'ccu-sync',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? USAGE_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    return { ok: false, status: null, error: name === 'TimeoutError' || name === 'AbortError' ? 'usage API timed out' : 'usage API unreachable' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: `usage API rejected the token (${res.status}); skipped` };
  if (!res.ok) return { ok: false, status: res.status, error: `usage API returned ${res.status}` };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, status: res.status, error: 'usage API returned invalid JSON' };
  }
}

// ---------------------------------------------------------------------------
// Loose parsing
// ---------------------------------------------------------------------------

export interface ParsedUsage {
  snapshot: LimitSnapshot;
  extraUsageEnabled: boolean | null;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function windowLabel(key: string, display?: string | null): string {
  if (key === 'five_hour') return '5-hour session';
  if (key === 'seven_day') return 'Weekly (all models)';
  if (key.startsWith('seven_day:')) return `Weekly (${display || titleCase(key.slice('seven_day:'.length))})`;
  return display ? `${titleCase(key.split(':')[0]!)} (${display})` : titleCase(key);
}

/** Maps one `limits[]` entry to a window key; scoped weekly limits become `seven_day:<model>`. */
function limitKey(l: Record<string, any>): { key: string; display: string | null } | null {
  const kind = typeof l.kind === 'string' ? l.kind : null;
  if (!kind) return null;
  const model = isObj(l.scope) && isObj(l.scope.model) && typeof l.scope.model.display_name === 'string' ? l.scope.model.display_name : null;
  const surface = isObj(l.scope) && typeof l.scope.surface === 'string' ? l.scope.surface : null;
  if (kind === 'session') return { key: 'five_hour', display: null };
  if (kind === 'weekly_all') return { key: 'seven_day', display: null };
  if (kind === 'weekly_scoped' || (l.group === 'weekly' && (model || surface))) {
    const name = model ?? surface;
    return name ? { key: `seven_day:${slug(name)}`, display: name } : null;
  }
  const name = model ?? surface;
  return { key: name ? `${slug(kind)}:${slug(name)}` : slug(kind), display: name };
}

function clampPct(v: number): number {
  return Math.min(1000, Math.max(0, v));
}

/**
 * Normalizes the usage response into a LimitSnapshot. Accepts `five_hour`, `seven_day`, any non-null
 * `seven_day_*` with a numeric utilization, and every `limits[]` entry. When both describe the same
 * window, the top-level float utilization wins and `limits[]` contributes severity / isActive.
 * Windows without a parseable `resets_at` are dropped (they have no active window).
 */
export function parseUsage(body: unknown, now: UnixSeconds): ParsedUsage {
  const windows = new Map<string, LimitWindow>();
  const o = isObj(body) ? body : {};

  for (const [field, v] of Object.entries(o)) {
    if (!(field === 'five_hour' || field === 'seven_day' || field.startsWith('seven_day_'))) continue;
    if (!isObj(v)) continue;
    const util = finite(v.utilization);
    const resetsAt = typeof v.resets_at === 'string' ? roundIsoToMinute(v.resets_at) : null;
    if (util == null || !resetsAt) continue;
    const key = limitWindowKey(field); // seven_day_opus -> seven_day:opus
    windows.set(key, { key, label: windowLabel(key), utilization: clampPct(util), resetsAt, severity: null, isActive: null });
  }

  const limits = Array.isArray(o.limits) ? o.limits : [];
  for (const l of limits) {
    if (!isObj(l)) continue;
    const k = limitKey(l);
    if (!k) continue;
    const severity = typeof l.severity === 'string' ? l.severity : null;
    const isActive = typeof l.is_active === 'boolean' ? l.is_active : null;
    const existing = windows.get(k.key);
    if (existing) {
      existing.severity = severity ?? existing.severity ?? null;
      existing.isActive = isActive ?? existing.isActive ?? null;
      if (k.display && existing.label === windowLabel(k.key)) existing.label = windowLabel(k.key, k.display);
      continue;
    }
    const pct = finite(l.percent) ?? finite(l.utilization);
    const resetsAt = typeof l.resets_at === 'string' ? roundIsoToMinute(l.resets_at) : null;
    if (pct == null || !resetsAt) continue;
    windows.set(k.key, { key: k.key, label: windowLabel(k.key, k.display), utilization: clampPct(pct), resetsAt, severity, isActive });
  }

  const extra = isObj(o.extra_usage) && typeof o.extra_usage.is_enabled === 'boolean' ? o.extra_usage.is_enabled : null;
  const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
  const list = [...windows.values()].sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  return { snapshot: { ts: now, windows: list }, extraUsageEnabled: extra };
}

export type LimitsPoll = { ok: true; parsed: ParsedUsage } | { ok: false; error: string };

/** Credentials -> request -> parse. Every failure is a short, token-free message. */
export async function pollLimits(credentialsFile: string, now: UnixSeconds, opts: { fetch?: FetchLike; timeoutMs?: number; userAgent?: string } = {}): Promise<LimitsPoll> {
  const t = readAccessToken(credentialsFile, now * 1000);
  if (!t.ok) return t;
  const r = await fetchUsage(t.token, opts);
  if (!r.ok) return { ok: false, error: r.error };
  const parsed = parseUsage(r.body, now);
  if (!parsed.snapshot.windows.length) return { ok: false, error: 'usage API response had no recognizable limit windows' };
  return { ok: true, parsed };
}

// ---------------------------------------------------------------------------
// Upload gating: only when a value changed or 15 minutes passed
// ---------------------------------------------------------------------------

export const LIMITS_RESEND_SECONDS = 15 * 60;

export interface LimitsUploadState {
  lastUploadTs: UnixSeconds | null;
  signature: string | null;
}

export function snapshotSignature(s: LimitSnapshot): string {
  return s.windows.map((w) => `${w.key}=${w.utilization}@${w.resetsAt}/${w.severity ?? ''}/${w.isActive ?? ''}`).join('|');
}

export function shouldUploadLimits(prev: LimitsUploadState, s: LimitSnapshot, now: UnixSeconds): boolean {
  if (prev.lastUploadTs == null || prev.signature == null) return true;
  if (snapshotSignature(s) !== prev.signature) return true;
  return now - prev.lastUploadTs >= LIMITS_RESEND_SECONDS;
}

export function readLimitsUploadState(path: string): LimitsUploadState {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    return { lastUploadTs: finite(o?.lastUploadTs), signature: typeof o?.signature === 'string' ? o.signature : null };
  } catch {
    return { lastUploadTs: null, signature: null };
  }
}
