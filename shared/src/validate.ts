import { isValidTimeZone } from './time.js';
import {
  AGENT_KINDS,
  type AgentKind,
  type CacheFile,
  type Config,
  type DailyLegacyIngest,
  type DailyLegacyRow,
  type HourlyBucket,
  type LimitHit,
  type LimitSnapshot,
  type LimitsIngest,
  type LimitWindow,
  type ProjectMeta,
  type SessionMeta,
  type Settings,
  type SettingsUpdate,
  type SyncRunStats,
  type UsageIngest,
} from './types.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** String length caps (characters). */
export const STRING_LIMITS = {
  project: 200,
  model: 100,
  sessionId: 100,
  title: 300,
  gitBranch: 200,
  label: 200,
  path: 500,
  device: 64,
  version: 32,
  kind: 64,
  windowKey: 100,
  severity: 32,
  error: 300,
  url: 500,
  token: 500,
  tz: 64,
} as const;

/** Array length caps per request. */
export const ARRAY_LIMITS = {
  buckets: 1000,
  sessions: 1000,
  projects: 500,
  limitHits: 1000,
  snapshots: 500,
  windowsPerSnapshot: 20,
  days: 5000,
  modelsPerSession: 50,
  unpricedModels: 100,
  errors: 50,
  thresholds: 5,
} as const;

/** Accepted unix-second range: 2017-07 .. 2099-12. */
export const TS_MIN = 1_500_000_000;
export const TS_MAX = 4_100_000_000;

/** Upper bound for any single token or request count (sanity, not a real limit). */
export const COUNT_MAX = 1e13;

class Invalid extends Error {}

function fail(path: string, msg: string): never {
  throw new Invalid(`${path}: ${msg}`);
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected object');
  return v as Obj;
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected array');
  if (v.length > max) fail(path, `too many items (max ${max})`);
  return v;
}

function str(v: unknown, path: string, max: number, { allowEmpty = false } = {}): string {
  if (typeof v !== 'string') fail(path, 'expected string');
  const s = v.trim();
  if (!allowEmpty && s.length === 0) fail(path, 'must not be empty');
  if (s.length > max) fail(path, `too long (max ${max})`);
  return s;
}

/** Optional string: undefined/null pass through as null; overlong values are truncated (cosmetic fields). */
function optStr(v: unknown, path: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(path, 'expected string');
  return v.trim().slice(0, max);
}

function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected finite number');
  if (v < min || v > max) fail(path, `out of range [${min}, ${max}]`);
  return v;
}

function count(v: unknown, path: string): number {
  const n = num(v, path, 0, COUNT_MAX);
  if (!Number.isInteger(n)) fail(path, 'expected integer');
  return n;
}

function optCount(v: unknown, path: string): number | null {
  return v === undefined || v === null ? null : count(v, path);
}

function ts(v: unknown, path: string): number {
  const n = num(v, path, TS_MIN, TS_MAX);
  if (!Number.isInteger(n)) fail(path, 'expected integer unix seconds');
  return n;
}

function optTs(v: unknown, path: string): number | null {
  return v === undefined || v === null ? null : ts(v, path);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected boolean');
  return v;
}

function iso(v: unknown, path: string): string {
  const s = str(v, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || !Number.isFinite(Date.parse(s))) fail(path, 'expected ISO-8601 timestamp');
  return s;
}

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function day(v: unknown, path: string): string {
  const s = str(v, path, 10);
  if (!DAY_RE.test(s) || !Number.isFinite(Date.parse(`${s}T00:00:00Z`))) fail(path, 'expected YYYY-MM-DD');
  return s;
}

function run<T>(fn: () => T): ValidationResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// POST /api/ingest/usage
// ---------------------------------------------------------------------------

function bucket(v: unknown, p: string): HourlyBucket {
  const o = obj(v, p);
  const hour = ts(o.hour, `${p}.hour`);
  if (hour % 3600 !== 0) fail(`${p}.hour`, 'must be a multiple of 3600');
  const agentKind = o.agentKind;
  if (!AGENT_KINDS.includes(agentKind as AgentKind)) fail(`${p}.agentKind`, `expected one of ${AGENT_KINDS.join(', ')}`);
  return {
    hour,
    project: str(o.project, `${p}.project`, STRING_LIMITS.project),
    model: str(o.model, `${p}.model`, STRING_LIMITS.model),
    agentKind: agentKind as AgentKind,
    sessionId: str(o.sessionId, `${p}.sessionId`, STRING_LIMITS.sessionId),
    input: count(o.input, `${p}.input`),
    output: count(o.output, `${p}.output`),
    cacheRead: count(o.cacheRead, `${p}.cacheRead`),
    cacheWrite5m: count(o.cacheWrite5m, `${p}.cacheWrite5m`),
    cacheWrite1h: count(o.cacheWrite1h, `${p}.cacheWrite1h`),
    webSearch: o.webSearch === undefined ? 0 : count(o.webSearch, `${p}.webSearch`),
    requests: count(o.requests, `${p}.requests`),
    costUsd: num(o.costUsd, `${p}.costUsd`, 0, 1e9),
  };
}

function session(v: unknown, p: string): SessionMeta {
  const o = obj(v, p);
  const firstTs = ts(o.firstTs, `${p}.firstTs`);
  const lastTs = ts(o.lastTs, `${p}.lastTs`);
  if (firstTs > lastTs) fail(p, 'firstTs must be <= lastTs');
  const models = o.models === undefined ? [] : arr(o.models, `${p}.models`, ARRAY_LIMITS.modelsPerSession);
  return {
    sessionId: str(o.sessionId, `${p}.sessionId`, STRING_LIMITS.sessionId),
    project: str(o.project, `${p}.project`, STRING_LIMITS.project),
    title: optStr(o.title, `${p}.title`, STRING_LIMITS.title),
    gitBranch: optStr(o.gitBranch, `${p}.gitBranch`, STRING_LIMITS.gitBranch),
    firstTs,
    lastTs,
    models: [...new Set(models.map((m, i) => str(m, `${p}.models[${i}]`, STRING_LIMITS.model)))],
    agentCount: o.agentCount === undefined ? 0 : count(o.agentCount, `${p}.agentCount`),
    costStateUsd: o.costStateUsd == null ? null : num(o.costStateUsd, `${p}.costStateUsd`, 0, 1e9),
    linesAdded: optCount(o.linesAdded, `${p}.linesAdded`),
    linesRemoved: optCount(o.linesRemoved, `${p}.linesRemoved`),
  };
}

function project(v: unknown, p: string): ProjectMeta {
  const o = obj(v, p);
  return {
    project: str(o.project, `${p}.project`, STRING_LIMITS.project),
    label: str(o.label, `${p}.label`, STRING_LIMITS.label),
    path: optStr(o.path, `${p}.path`, STRING_LIMITS.path),
  };
}

function limitHit(v: unknown, p: string): LimitHit {
  const o = obj(v, p);
  return {
    ts: ts(o.ts, `${p}.ts`),
    kind: o.kind == null ? 'unknown' : str(o.kind, `${p}.kind`, STRING_LIMITS.kind),
    resetsAt: optTs(o.resetsAt, `${p}.resetsAt`),
  };
}

function stats(v: unknown, p: string): SyncRunStats {
  const o = obj(v, p);
  const out: SyncRunStats = {};
  if (o.outputIncomplete != null) out.outputIncomplete = count(o.outputIncomplete, `${p}.outputIncomplete`);
  if (o.unpricedModels != null)
    out.unpricedModels = arr(o.unpricedModels, `${p}.unpricedModels`, ARRAY_LIMITS.unpricedModels).map((m, i) =>
      str(m, `${p}.unpricedModels[${i}]`, STRING_LIMITS.model),
    );
  if (o.errors != null)
    out.errors = arr(o.errors, `${p}.errors`, ARRAY_LIMITS.errors).map((m, i) => {
      if (typeof m !== 'string') fail(`${p}.errors[${i}]`, 'expected string');
      return m.slice(0, STRING_LIMITS.error);
    });
  return out;
}

export function validateUsageIngest(body: unknown): ValidationResult<UsageIngest> {
  return run(() => {
    const o = obj(body, 'body');
    const out: UsageIngest = {
      device: str(o.device, 'device', STRING_LIMITS.device),
      version: str(o.version, 'version', STRING_LIMITS.version),
      buckets: arr(o.buckets ?? [], 'buckets', ARRAY_LIMITS.buckets).map((b, i) => bucket(b, `buckets[${i}]`)),
    };
    if (o.sessions != null) out.sessions = arr(o.sessions, 'sessions', ARRAY_LIMITS.sessions).map((s, i) => session(s, `sessions[${i}]`));
    if (o.projects != null) out.projects = arr(o.projects, 'projects', ARRAY_LIMITS.projects).map((s, i) => project(s, `projects[${i}]`));
    if (o.limitHits != null) out.limitHits = arr(o.limitHits, 'limitHits', ARRAY_LIMITS.limitHits).map((s, i) => limitHit(s, `limitHits[${i}]`));
    if (o.pending != null) out.pending = count(o.pending, 'pending');
    if (o.stats != null) out.stats = stats(o.stats, 'stats');
    return out;
  });
}

// ---------------------------------------------------------------------------
// POST /api/ingest/limits
// ---------------------------------------------------------------------------

function limitWindow(v: unknown, p: string): LimitWindow {
  const o = obj(v, p);
  return {
    key: str(o.key, `${p}.key`, STRING_LIMITS.windowKey),
    label: o.label == null ? str(o.key, `${p}.key`, STRING_LIMITS.windowKey) : str(o.label, `${p}.label`, STRING_LIMITS.label),
    utilization: num(o.utilization, `${p}.utilization`, 0, 1000),
    resetsAt: iso(o.resetsAt, `${p}.resetsAt`),
    severity: optStr(o.severity, `${p}.severity`, STRING_LIMITS.severity),
    isActive: o.isActive == null ? null : bool(o.isActive, `${p}.isActive`),
  };
}

function snapshot(v: unknown, p: string): LimitSnapshot {
  const o = obj(v, p);
  return {
    ts: ts(o.ts, `${p}.ts`),
    windows: arr(o.windows, `${p}.windows`, ARRAY_LIMITS.windowsPerSnapshot).map((w, i) => limitWindow(w, `${p}.windows[${i}]`)),
  };
}

export function validateLimitsIngest(body: unknown): ValidationResult<LimitsIngest> {
  return run(() => {
    const o = obj(body, 'body');
    const out: LimitsIngest = {
      snapshots: arr(o.snapshots, 'snapshots', ARRAY_LIMITS.snapshots).map((s, i) => snapshot(s, `snapshots[${i}]`)),
    };
    if (o.device != null) out.device = str(o.device, 'device', STRING_LIMITS.device);
    return out;
  });
}

// ---------------------------------------------------------------------------
// POST /api/ingest/daily-legacy
// ---------------------------------------------------------------------------

function legacyRow(v: unknown, p: string): DailyLegacyRow {
  const o = obj(v, p);
  return {
    day: day(o.day, `${p}.day`),
    model: str(o.model, `${p}.model`, STRING_LIMITS.model),
    tokens: count(o.tokens, `${p}.tokens`),
    requests: count(o.requests, `${p}.requests`),
  };
}

export function validateDailyLegacyIngest(body: unknown): ValidationResult<DailyLegacyIngest> {
  return run(() => {
    const o = obj(body, 'body');
    return { days: arr(o.days, 'days', ARRAY_LIMITS.days).map((r, i) => legacyRow(r, `days[${i}]`)) };
  });
}

// ---------------------------------------------------------------------------
// PUT /api/settings
// ---------------------------------------------------------------------------

function thresholds(v: unknown, p: string): number[] {
  const list = arr(v, p, ARRAY_LIMITS.thresholds).map((t, i) => num(t, `${p}[${i}]`, 1, 100));
  return [...new Set(list)].sort((a, b) => a - b);
}

export function validateSettingsUpdate(body: unknown): ValidationResult<SettingsUpdate> {
  return run(() => {
    const o = obj(body, 'body');
    const out: SettingsUpdate = {};
    if (o.dailyBudgetUsd !== undefined) out.dailyBudgetUsd = num(o.dailyBudgetUsd, 'dailyBudgetUsd', 0, 1e6);
    if (o.alertThresholds !== undefined) {
      const t = obj(o.alertThresholds, 'alertThresholds');
      out.alertThresholds = {
        fiveHour: thresholds(t.fiveHour, 'alertThresholds.fiveHour'),
        weekly: thresholds(t.weekly, 'alertThresholds.weekly'),
      };
    }
    if (o.weeklyPaceAlert !== undefined) out.weeklyPaceAlert = bool(o.weeklyPaceAlert, 'weeklyPaceAlert');
    if (o.staleSyncMinutes !== undefined) {
      const m = num(o.staleSyncMinutes, 'staleSyncMinutes', 5, 7 * 24 * 60);
      if (!Number.isInteger(m)) fail('staleSyncMinutes', 'expected integer');
      out.staleSyncMinutes = m;
    }
    if (o.ntfyEnabled !== undefined) out.ntfyEnabled = bool(o.ntfyEnabled, 'ntfyEnabled');
    return out;
  });
}

/** Applies a validated update to current settings. */
export function mergeSettings(current: Settings, update: SettingsUpdate): Settings {
  return {
    ...current,
    ...update,
    alertThresholds: update.alertThresholds ?? current.alertThresholds,
  };
}

// ---------------------------------------------------------------------------
// ~/.claude-usage/config.json and cache.json
// ---------------------------------------------------------------------------

export function validateConfig(body: unknown): ValidationResult<Config> {
  return run(() => {
    const o = obj(body, 'config');
    const apiUrl = str(o.apiUrl, 'apiUrl', STRING_LIMITS.url).replace(/\/+$/, '');
    // Regex rather than URL so shared needs neither DOM nor Node lib types.
    const m = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?(\/[^\s?#]*)?$/i.exec(apiUrl);
    if (!m) fail('apiUrl', 'expected absolute http(s) URL');
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(m[2]!);
    if (m[1]!.toLowerCase() !== 'https' && !isLocal) fail('apiUrl', 'must be https (http only for localhost)');
    const tz = str(o.tz, 'tz', STRING_LIMITS.tz);
    if (!isValidTimeZone(tz)) fail('tz', 'unknown IANA timezone');
    const out: Config = {
      apiUrl,
      writeToken: str(o.writeToken, 'writeToken', STRING_LIMITS.token),
      tz,
      deviceName: str(o.deviceName, 'deviceName', STRING_LIMITS.device),
    };
    if (o.readToken != null) out.readToken = str(o.readToken, 'readToken', STRING_LIMITS.token);
    if (o.ntfyTopic != null) out.ntfyTopic = str(o.ntfyTopic, 'ntfyTopic', STRING_LIMITS.label);
    if (o.maxRowsPerRun != null) {
      const n = count(o.maxRowsPerRun, 'maxRowsPerRun');
      if (n < 1) fail('maxRowsPerRun', 'must be >= 1');
      out.maxRowsPerRun = n;
    }
    if (o.claudeDir != null) out.claudeDir = str(o.claudeDir, 'claudeDir', STRING_LIMITS.path);
    return out;
  });
}

/**
 * Lenient cache.json reader for the statusline: returns null for anything that
 * is not a version-1 cache file, instead of throwing. Fields are trusted (we wrote them).
 */
export function parseCacheFile(text: string): CacheFile | null {
  try {
    const v = JSON.parse(text) as Partial<CacheFile> | null;
    if (!v || typeof v !== 'object' || v.version !== 1) return null;
    if (!v.limits || !Array.isArray(v.limits.windows) || !v.today || typeof v.today.costUsd !== 'number') return null;
    return {
      ...v,
      errors: Array.isArray(v.errors) ? v.errors : [],
      pending: typeof v.pending === 'number' ? v.pending : 0,
      burnRatePerHour: typeof v.burnRatePerHour === 'number' ? v.burnRatePerHour : 0,
    } as CacheFile;
  } catch {
    return null;
  }
}
