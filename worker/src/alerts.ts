// Phone alerts via ntfy. Rule evaluation is pure (evaluateRules); the IO wrappers
// (runAlerts, evaluateAfterLimits) gather a handful of indexed rows, dedupe against
// alert_state and send. Budget per run: ~6 small queries + at most MAX_SENDS fetches.
import {
  DAY,
  dayKey,
  dayStart,
  formatCountdown,
  HOUR,
  hourOfDay,
  limitWindowKey,
  MINUTE,
  projectWindow,
  SEVEN_DAY_SECONDS,
  windowSeconds,
  type Settings,
  type UnixSeconds,
} from '@ccu/shared';
import { all, first, getSettings, type Env } from './db.js';
import { HOUR_MID } from './routes/read-days.js';
import { HIT_MATCH_WINDOW } from './upserts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NtfyPriority = 'min' | 'low' | 'default' | 'high' | 'urgent';

export interface NtfyMessage {
  title: string;
  message: string;
  priority: NtfyPriority;
  tags: string[];
  click?: string;
}

export interface NtfyResult {
  sent: boolean;
  error?: string;
}

/** Optional extra var, not in the shared Env: the dashboard URL used as the ntfy `Click` target. */
export type AlertEnv = Env & { DASHBOARD_URL?: string };

/** Latest snapshot of one limit window. */
export interface WindowState {
  key: string;
  ts: UnixSeconds;
  utilization: number;
  resetsAt: UnixSeconds;
}

export interface HitRow {
  ts: UnixSeconds;
  kind: string;
  resetsAt: UnixSeconds | null;
}

export interface RuleInput {
  now: UnixSeconds;
  tz: string;
  settings: Settings;
  windows: WindowState[];
  /** Today's (local day) API-equivalent cost; null when not loaded (budget rule skipped). */
  todayCostUsd: number | null;
  /** Latest sync_runs.ts; null when never synced or not loaded. */
  lastSyncTs: UnixSeconds | null;
  /** Limit hits inside HIT_LOOKBACK. */
  hits: HitRow[];
  /** alert_state keys already fired; lets a typed hit defer to an unknown one already sent. */
  fired?: ReadonlySet<string>;
}

export type AlertRule = 'threshold' | 'pace' | 'budget' | 'stale' | 'hit';

export interface Alert extends NtfyMessage {
  rule: AlertRule;
  /** alert_state primary key: unique per (rule, window, reset). */
  key: string;
  /** Keys recorded alongside `key` (lower thresholds a jump skipped past). */
  covers: string[];
  windowReset: UnixSeconds | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PACE_ALERT = 1.15;
/** Stale-sync alerts only between these local hours: [start, end). */
export const QUIET_END_HOUR = 8;
export const QUIET_START_HOUR = 23;
/** Only hits this recent are "new"; older ones (e.g. from a backfill) never alert. */
export const HIT_LOOKBACK = 2 * HOUR;
/** How long an OTLP-only (`unknown`) hit waits for sync to report its typed twin. */
export const UNKNOWN_HIT_GRACE = 10 * MINUTE;
const UNKNOWN_KEY_PREFIX = 'hit:unknown:';
export { ALERT_STATE_RETENTION } from './prune.js';
/** Bounds ntfy subrequests per invocation. */
export const MAX_SENDS = 5;
export const NTFY_TIMEOUT_MS = 5000;
const HIGH_AT = 90;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isWeekly(key: string): boolean {
  return windowSeconds(key) === SEVEN_DAY_SECONDS;
}

function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** Human label for a window key (labels are not stored with snapshots). */
export function windowLabel(key: string): string {
  if (key === 'five_hour') return '5-hour session';
  if (key === 'seven_day') return 'Weekly (all models)';
  const m = /^seven_day[:_](.+)$/.exec(key);
  if (m) return `Weekly (${titleCase(m[1]!)})`;
  return titleCase(key);
}

function thresholdsFor(key: string, settings: Settings): number[] {
  const list = isWeekly(key) ? settings.alertThresholds.weekly : settings.alertThresholds.fiveHour;
  return list.filter((t) => Number.isFinite(t) && t > 0 && t <= 100).sort((a, b) => a - b);
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** ntfy reads headers as latin-1; keep them plain ASCII. */
export function asciiHeader(s: string): string {
  return s.replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '').trim();
}

// ---------------------------------------------------------------------------
// Rules (pure)
// ---------------------------------------------------------------------------

/** Highest threshold crossed per active window. Lower thresholds are covered so a jump sends one push. */
export function thresholdAlerts(windows: WindowState[], settings: Settings, now: UnixSeconds): Alert[] {
  const out: Alert[] = [];
  for (const w of windows) {
    if (w.resetsAt <= now) continue;
    const crossed = thresholdsFor(w.key, settings).filter((t) => w.utilization >= t);
    const top = crossed.at(-1);
    if (top === undefined) continue;
    const keyOf = (t: number) => `threshold:${w.key}:${t}:${w.resetsAt}`;
    const label = windowLabel(w.key);
    out.push({
      rule: 'threshold',
      key: keyOf(top),
      covers: crossed.slice(0, -1).map(keyOf),
      windowReset: w.resetsAt,
      title: `${label} limit at ${pct(w.utilization)}`,
      message: `${label} usage crossed ${top}%. Resets in ${formatCountdown(w.resetsAt - now)}.`,
      priority: w.utilization >= HIGH_AT ? 'high' : 'default',
      tags: [w.utilization >= HIGH_AT ? 'rotating_light' : 'warning'],
    });
  }
  return out;
}

/** Weekly windows on track to run out more than a day before reset. */
export function paceAlerts(windows: WindowState[], settings: Settings, now: UnixSeconds): Alert[] {
  if (!settings.weeklyPaceAlert) return [];
  const out: Alert[] = [];
  for (const w of windows) {
    if (!isWeekly(w.key) || w.resetsAt <= now || w.utilization >= 100) continue;
    const p = projectWindow(w.utilization, w.resetsAt, SEVEN_DAY_SECONDS, now);
    if (p.pace == null || p.pace <= PACE_ALERT || p.secondsToReset <= DAY || p.projectedFullAt == null) continue;
    const label = windowLabel(w.key);
    out.push({
      rule: 'pace',
      key: `pace:${w.key}:${w.resetsAt}`,
      covers: [],
      windowReset: w.resetsAt,
      title: `${label} pace ${p.pace.toFixed(2)}x`,
      message:
        `${label} is at ${pct(w.utilization)} and on pace to hit 100% in ${formatCountdown(p.projectedFullAt - now)}, ` +
        `before the reset in ${formatCountdown(p.secondsToReset)}.`,
      priority: 'default',
      tags: ['chart_with_upwards_trend'],
    });
  }
  return out;
}

export function budgetAlert(costUsd: number | null, settings: Settings, now: UnixSeconds, tz: string): Alert | null {
  const budget = settings.dailyBudgetUsd;
  if (costUsd == null || !(budget > 0) || costUsd < budget) return null;
  const day = dayKey(now, tz);
  return {
    rule: 'budget',
    key: `budget:${day}`,
    covers: [],
    windowReset: dayStart(now, tz) + DAY,
    title: `Daily budget reached: ${usd(costUsd)}`,
    message: `Today's API-equivalent cost is ${usd(costUsd)}, over the ${usd(budget)} daily budget.`,
    priority: 'high',
    tags: ['moneybag'],
  };
}

/** True during local waking hours (08:00-23:00). */
export function isAwake(now: UnixSeconds, tz: string): boolean {
  const h = hourOfDay(now, tz);
  return h >= QUIET_END_HOUR && h < QUIET_START_HOUR;
}

/** One alert per stall: keyed by the last sync time, so a resumed-then-stalled sync alerts again. */
export function staleAlert(lastSyncTs: UnixSeconds | null, settings: Settings, now: UnixSeconds, tz: string): Alert | null {
  if (lastSyncTs == null) return null;
  const limit = Math.max(5, settings.staleSyncMinutes || 60) * MINUTE;
  const age = now - lastSyncTs;
  if (age <= limit || !isAwake(now, tz)) return null;
  return {
    rule: 'stale',
    key: `stale:${lastSyncTs}`,
    covers: [],
    windowReset: lastSyncTs,
    title: 'Usage sync is stale',
    message: `No sync for ${formatCountdown(age)}. Check the ClaudeUsageSync scheduled task.`,
    priority: 'default',
    tags: ['hourglass'],
  };
}

/**
 * One alert per (kind, reset); hits without a reset key on their timestamp.
 * OTLP only knows "a 429 happened" (`unknown`) while sync later reports the typed
 * hit for the same event, so: unknown hits wait UNKNOWN_HIT_GRACE for sync to
 * supersede them, are dropped when a typed hit is within HIT_MATCH_WINDOW, and
 * collapse with nearby unknowns; a typed hit near an already-alerted unknown one
 * (sync ran late) does not alert again.
 */
export function hitAlerts(hits: HitRow[], now: UnixSeconds, fired: ReadonlySet<string> = new Set()): Alert[] {
  const near = (ts: number, list: readonly number[]) => list.some((t) => Math.abs(t - ts) <= HIT_MATCH_WINDOW);
  const firedUnknown = [...fired].filter((k) => k.startsWith(UNKNOWN_KEY_PREFIX)).map((k) => Number(k.slice(UNKNOWN_KEY_PREFIX.length)));
  const typedTs = hits.filter((h) => h.kind !== 'unknown').map((h) => h.ts);
  const unknownSeen = [...firedUnknown];
  const suppressed = new Set<string>();
  const byKey = new Map<string, Alert>();
  for (const h of [...hits].sort((a, b) => a.ts - b.ts)) {
    if (h.ts < now - HIT_LOOKBACK || h.ts > now + 5 * MINUTE) continue;
    const reset = h.resetsAt ?? null;
    const key = `hit:${h.kind}:${reset ?? h.ts}`;
    if (byKey.has(key) || suppressed.has(key)) continue;
    if (h.kind === 'unknown') {
      if (now - h.ts < UNKNOWN_HIT_GRACE || near(h.ts, typedTs) || near(h.ts, unknownSeen)) continue;
      unknownSeen.push(h.ts);
    } else if (near(h.ts, firedUnknown)) {
      suppressed.add(key);
      continue;
    }
    const label = h.kind === 'unknown' ? 'A rate limit (HTTP 429)' : windowLabel(h.kind);
    byKey.set(key, {
      rule: 'hit',
      key,
      covers: [],
      windowReset: reset,
      title: `Limit hit: ${label}`,
      message: reset && reset > now ? `${label} was hit. Resets in ${formatCountdown(reset - now)}.` : `${label} was hit.`,
      priority: 'urgent',
      tags: ['no_entry'],
    });
  }
  return [...byKey.values()];
}

/** Every rule over the input, in priority order (most urgent first). */
export function evaluateRules(input: RuleInput): Alert[] {
  const { now, tz, settings } = input;
  const alerts = [
    ...hitAlerts(input.hits, now, input.fired),
    ...thresholdAlerts(input.windows, settings, now),
    budgetAlert(input.todayCostUsd, settings, now, tz),
    ...paceAlerts(input.windows, settings, now),
    staleAlert(input.lastSyncTs, settings, now, tz),
  ].filter((a): a is Alert => a !== null);
  const rank: Record<NtfyPriority, number> = { urgent: 0, high: 1, default: 2, low: 3, min: 4 };
  return alerts.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** Drops alerts already fired (by key or covered key). */
export function dedupe(alerts: Alert[], fired: ReadonlySet<string>): Alert[] {
  return alerts.filter((a) => !fired.has(a.key));
}

// ---------------------------------------------------------------------------
// ntfy delivery
// ---------------------------------------------------------------------------

export function ntfyUrl(env: Pick<Env, 'NTFY_TOPIC' | 'NTFY_SERVER'>): string | null {
  const topic = env.NTFY_TOPIC?.trim();
  if (!topic) return null;
  const server = (env.NTFY_SERVER?.trim() || 'https://ntfy.sh').replace(/\/+$/, '');
  return `${server}/${encodeURIComponent(topic)}`;
}

/** POSTs one push. No-op ({sent:false}) when no topic is configured. Never throws. */
export async function sendNtfy(env: Pick<Env, 'NTFY_TOPIC' | 'NTFY_SERVER'>, msg: NtfyMessage): Promise<NtfyResult> {
  const url = ntfyUrl(env);
  if (!url) return { sent: false, error: 'NTFY_TOPIC is not set' };
  const headers: Record<string, string> = {
    Title: asciiHeader(msg.title),
    Priority: msg.priority,
    'Content-Type': 'text/plain; charset=utf-8',
  };
  const tags = msg.tags.map(asciiHeader).filter(Boolean);
  if (tags.length) headers.Tags = tags.join(',');
  if (msg.click) headers.Click = asciiHeader(msg.click);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: msg.message, signal: AbortSignal.timeout(NTFY_TIMEOUT_MS) });
    if (!res.ok) return { sent: false, error: `ntfy responded ${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/**
 * Latest snapshot per window via a manual skip-scan over the (window_key, ts) primary
 * key: reads O(windows) rows instead of every snapshot.
 */
const LATEST_WINDOWS_SQL = `
WITH RECURSIVE k(key) AS (
  SELECT MIN(window_key) FROM limit_snapshots
  UNION ALL
  SELECT (SELECT MIN(window_key) FROM limit_snapshots WHERE window_key > k.key) FROM k WHERE k.key IS NOT NULL
)
SELECT s.window_key AS key, s.ts AS ts, s.utilization AS utilization, s.resets_at AS resetsAt
FROM k JOIN limit_snapshots AS s
  ON s.window_key = k.key
 AND s.ts = (SELECT MAX(ts) FROM limit_snapshots WHERE window_key = k.key)`;

export async function loadWindows(db: D1Database, now: UnixSeconds): Promise<WindowState[]> {
  const rows = await all<WindowState>(db, LATEST_WINDOWS_SQL);
  return rows.filter((w) => w.resetsAt > now);
}

async function loadFired(db: D1Database): Promise<Set<string>> {
  const rows = await all<{ alert_key: string }>(db, 'SELECT alert_key FROM alert_state');
  return new Set(rows.map((r) => r.alert_key));
}

/** Same day rule as the dashboard: an hour bucket belongs to the local day containing its midpoint. */
export const TODAY_COST_SQL = 'SELECT SUM(cost_usd) AS cost FROM usage_hourly WHERE hour >= ?1 AND hour <= ?2';

export async function loadTodayCost(db: D1Database, now: UnixSeconds, tz: string): Promise<number> {
  const row = await first<{ cost: number | null }>(db, TODAY_COST_SQL, dayStart(now, tz) - HOUR_MID, now);
  return row?.cost ?? 0;
}

async function loadLastSync(db: D1Database): Promise<UnixSeconds | null> {
  const row = await first<{ ts: number | null }>(db, 'SELECT MAX(ts) AS ts FROM sync_runs');
  return row?.ts ?? null;
}

async function loadHits(db: D1Database, now: UnixSeconds): Promise<HitRow[]> {
  const rows = await all<HitRow>(db, 'SELECT ts, kind, resets_at AS resetsAt FROM limit_hits WHERE ts >= ?1', now - HIT_LOOKBACK);
  return rows.map((r) => ({ ...r, kind: limitWindowKey(r.kind) }));
}

function alertsEnabled(env: Env, settings: Settings): boolean {
  return settings.ntfyEnabled && ntfyUrl(env) !== null;
}

/** Sends up to MAX_SENDS alerts and records the delivered ones (plus covered keys) in alert_state. */
async function deliver(env: AlertEnv, alerts: Alert[], now: UnixSeconds): Promise<Alert[]> {
  const sent: Alert[] = [];
  for (const a of alerts.slice(0, MAX_SENDS)) {
    const res = await sendNtfy(env, { title: a.title, message: a.message, priority: a.priority, tags: a.tags, click: env.DASHBOARD_URL || undefined });
    if (res.sent) sent.push(a);
    else console.warn('ntfy send failed', a.rule, res.error);
  }
  const stmt = env.DB.prepare('INSERT OR REPLACE INTO alert_state (alert_key, fired_at, window_reset) VALUES (?1, ?2, ?3)');
  const rows = sent.flatMap((a) => [a.key, ...a.covers].map((k) => stmt.bind(k, now, a.windowReset)));
  if (rows.length) await env.DB.batch(rows);
  return sent;
}

export interface AlertRunResult {
  evaluated: number;
  sent: Alert[];
}

const EMPTY: AlertRunResult = { evaluated: 0, sent: [] };

/** Cron entry point (every 5 minutes): every rule. alert_state is pruned hourly by `prune`. */
export async function runAlerts(env: AlertEnv, nowSec: number): Promise<AlertRunResult> {
  const settings = await getSettings(env);
  if (!alertsEnabled(env, settings)) return EMPTY;
  const tz = env.TZ_NAME || 'UTC';
  const fired = await loadFired(env.DB);
  const budgetFired = fired.has(`budget:${dayKey(nowSec, tz)}`);
  const [windows, todayCostUsd, lastSyncTs, hits] = await Promise.all([
    loadWindows(env.DB, nowSec),
    settings.dailyBudgetUsd > 0 && !budgetFired ? loadTodayCost(env.DB, nowSec, tz) : Promise.resolve(null),
    loadLastSync(env.DB),
    loadHits(env.DB, nowSec),
  ]);
  const alerts = dedupe(evaluateRules({ now: nowSec, tz, settings, windows, todayCostUsd, lastSyncTs, hits, fired }), fired);
  return { evaluated: alerts.length, sent: await deliver(env, alerts, nowSec) };
}

/** After POST /api/ingest/limits: only the limit-window rules (thresholds, pace). */
export async function evaluateAfterLimits(env: AlertEnv, nowSec: number): Promise<AlertRunResult> {
  const settings = await getSettings(env);
  if (!alertsEnabled(env, settings)) return EMPTY;
  const tz = env.TZ_NAME || 'UTC';
  const [fired, windows] = await Promise.all([loadFired(env.DB), loadWindows(env.DB, nowSec)]);
  const input: RuleInput = { now: nowSec, tz, settings, windows, todayCostUsd: null, lastSyncTs: null, hits: [] };
  const alerts = dedupe(evaluateRules(input), fired);
  return { evaluated: alerts.length, sent: await deliver(env, alerts, nowSec) };
}
