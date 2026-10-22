// The cross-package contract. JSON field names are camelCase. All timestamps are
// unix seconds (UTC) unless a field name or comment says otherwise.

export type UnixSeconds = number;
/** Local calendar day in the user's timezone, `YYYY-MM-DD`. */
export type DayKey = string;

export type AgentKind = 'main' | 'subagent' | 'workflow';
export const AGENT_KINDS: readonly AgentKind[] = ['main', 'subagent', 'workflow'];

export type Speed = 'standard' | 'fast';

/** Token categories, as used by `group=type` timeseries series keys. */
export type TokenType = 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h';
export const TOKEN_TYPES: readonly TokenType[] = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

/** Token counts of one request or a sum of requests. `webSearch` counts requests, not tokens. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
}

/** UsageTokens plus derived totals; the common shape of every aggregate row in the read API. */
export interface UsageTotals extends UsageTokens {
  /** input + output + cacheRead + cacheWrite5m + cacheWrite1h */
  totalTokens: number;
  requests: number;
  /** API-equivalent cost in USD. */
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Ingest payloads (sync -> worker, Bearer WRITE_TOKEN)
// ---------------------------------------------------------------------------

/**
 * One row of `usage_hourly`. Absolute values (the full sum for the key, not a delta):
 * the worker upserts by (hour, project, model, agentKind, sessionId).
 */
export interface HourlyBucket extends UsageTokens {
  /** UTC hour start, unix seconds, multiple of 3600. */
  hour: UnixSeconds;
  /** Project key (normalized cwd / git root path, see ProjectMeta). */
  project: string;
  /** Model id as seen in the transcript, lowercased with any `[1m]` suffix removed. */
  model: string;
  agentKind: AgentKind;
  sessionId: string;
  requests: number;
  /** Computed by sync with shared pricing, summed per request. 0 for unpriced models. */
  costUsd: number;
}

export interface SessionMeta {
  sessionId: string;
  project: string;
  /** From the transcript's `ai-title` record. */
  title?: string | null;
  gitBranch?: string | null;
  firstTs: UnixSeconds;
  lastTs: UnixSeconds;
  /** Distinct model ids used in the session. */
  models: string[];
  /** Number of subagent + workflow agent transcripts in the session. */
  agentCount: number;
  /** From the last `cost-state` record: Claude Code's own session total. */
  costStateUsd?: number | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
}

export interface ProjectMeta {
  /** Stable key: normalized absolute path (lowercase drive, forward slashes). */
  project: string;
  /** Display label: last path segment, plus the parent segment when two labels collide. */
  label: string;
  path?: string | null;
}

/** A plan-limit hit (synthetic 429 in a transcript, or an OTel api_error 429). */
export interface LimitHit {
  ts: UnixSeconds;
  /** The transcript's `rateLimitType` (e.g. `five_hour`, `seven_day`), or `unknown`. */
  kind: string;
  resetsAt?: UnixSeconds | null;
}

/** Non-fatal per-run stats the sync tool reports alongside buckets. */
export interface SyncRunStats {
  /** Requests counted without a final transcript line (output likely undercounted). */
  outputIncomplete?: number;
  /** Model ids seen with no price. */
  unpricedModels?: string[];
  /** Short, token-free error messages from this run. */
  errors?: string[];
}

export interface UsageIngest {
  device: string;
  /** Sync tool version. */
  version: string;
  buckets: HourlyBucket[];
  sessions?: SessionMeta[];
  projects?: ProjectMeta[];
  limitHits?: LimitHit[];
  /** Rows still waiting to upload after this request (backfill progress). */
  pending?: number;
  stats?: SyncRunStats;
}

/** Window keys: `five_hour`, `seven_day`, `seven_day:<model>` (e.g. `seven_day:fable`), or other API keys. */
export type LimitWindowKey = string;

export interface LimitWindow {
  key: LimitWindowKey;
  /** Human label, e.g. "5-hour session", "Weekly (all models)", "Weekly (Fable)". */
  label: string;
  /** 0-100. */
  utilization: number;
  /** ISO-8601, rounded to the minute (the API jitters by < 1 s). */
  resetsAt: string;
  /** Server hint: "normal" | "warning" | "critical" | ... */
  severity?: string | null;
  /** True when this is the currently binding limit. */
  isActive?: boolean | null;
}

export interface LimitSnapshot {
  ts: UnixSeconds;
  windows: LimitWindow[];
}

export interface LimitsIngest {
  snapshots: LimitSnapshot[];
  device?: string;
}

export interface DailyLegacyRow {
  day: DayKey;
  model: string;
  tokens: number;
  requests: number;
}

export interface DailyLegacyIngest {
  days: DailyLegacyRow[];
}

export interface IngestAccepted {
  buckets?: number;
  sessions?: number;
  projects?: number;
  limitHits?: number;
  snapshots?: number;
  windows?: number;
  days?: number;
}

export interface IngestResponse {
  ok: true;
  accepted: IngestAccepted;
}

export interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// Read API (Bearer READ_TOKEN or WRITE_TOKEN)
// ---------------------------------------------------------------------------

export interface TimeRange {
  from: UnixSeconds;
  to: UnixSeconds;
}

export type TimeseriesBucket = 'hour' | 'day';
export type TimeseriesGroup = 'model' | 'project' | 'agent_kind' | 'type';
export type TimeseriesMetric = 'cost' | 'tokens' | 'requests';

/** `[bucketStartUnixSeconds, value]`. Day buckets start at local midnight in `tz`. */
export type TimeseriesPoint = [t: UnixSeconds, value: number];

export interface TimeseriesSeries {
  /** Group value: model id, project key, agent kind, or TokenType. */
  key: string;
  /** Display label when it differs from key (project label). */
  label?: string;
  points: TimeseriesPoint[];
}

/** Aggregates over one period with cache metrics. */
export interface PeriodKpis extends UsageTotals {
  sessions: number;
  /** cacheRead / (input + cacheRead + cacheWrite5m + cacheWrite1h); null when there were no input tokens. */
  cacheHitRate: number | null;
  /** USD saved versus sending every cached token as plain input. */
  cacheSavingsUsd: number;
}

export interface BurnRate {
  windowMinutes: number;
  costPerHour: number;
  tokensPerMinute: number;
  requests: number;
  /** Where the numbers came from: OTel live table, hourly rollups, or both merged. */
  source: 'live' | 'hourly' | 'merged';
}

/** Latest snapshot of one limit window, with pace and projection. */
export interface LimitWindowStatus {
  key: LimitWindowKey;
  label: string;
  /** 0-100 */
  utilization: number;
  resetsAt: UnixSeconds;
  severity: string | null;
  /** When this value was observed. */
  snapshotTs: UnixSeconds;
  /** Window length: 18000 for five_hour, 604800 for weekly windows. */
  windowSeconds: number;
  /** 0-1 fraction of the window elapsed at `now`. */
  elapsedFraction: number;
  /** (utilization/100) / elapsedFraction; 1 = on track to hit exactly 100% at reset. Null early in a window. */
  pace: number | null;
  /** Linear projection of when utilization reaches 100%; null if not before reset or no usage yet. */
  projectedFullAt: UnixSeconds | null;
  /** Linear projection of utilization at reset (may exceed 100). Null when pace is null. */
  projectedAtReset: number | null;
}

export interface SyncInfo {
  lastSyncTs: UnixSeconds | null;
  ageSeconds: number | null;
  pending: number;
  device: string | null;
}

export interface SummaryResponse {
  generatedAt: UnixSeconds;
  tz: string;
  today: PeriodKpis;
  last7d: PeriodKpis;
  last30d: PeriodKpis;
  burnRate: BurnRate;
  limits: LimitWindowStatus[];
  sync: SyncInfo;
  /** Distinct model ids in range that have no price. */
  unpricedModels: string[];
  hasUnpriced: boolean;
  /** 0 = off */
  dailyBudgetUsd: number;
}

export interface TimeseriesResponse extends TimeRange {
  bucket: TimeseriesBucket;
  group: TimeseriesGroup;
  metric: TimeseriesMetric;
  tz: string;
  series: TimeseriesSeries[];
}

export interface LimitHistoryPoint {
  ts: UnixSeconds;
  utilization: number;
  resetsAt: UnixSeconds;
  severity: string | null;
}

export interface LimitHistorySeries {
  key: LimitWindowKey;
  label: string;
  points: LimitHistoryPoint[];
}

/** A reconstructed 5-hour session block: start = resetsAt - 5h. */
export interface FiveHourBlock {
  start: UnixSeconds;
  /** The window's resetsAt. */
  end: UnixSeconds;
  peakUtilization: number;
  costUsd: number;
  tokens: number;
  requests: number;
  /** costUsd / peakUtilization; an estimate of the plan's capacity. Null when peak is 0. */
  costPerPercent: number | null;
  /** True when `now` is inside the block. */
  active: boolean;
}

export interface LimitsResponse extends TimeRange {
  windows: LimitHistorySeries[];
  hits: LimitHit[];
  blocks: FiveHourBlock[];
  /** Latest status per window (same as SummaryResponse.limits). */
  current: LimitWindowStatus[];
}

export interface DailyCostPoint {
  day: DayKey;
  costUsd: number;
}

export interface ProjectRow extends UsageTotals {
  project: string;
  label: string;
  path: string | null;
  sessions: number;
  cacheHitRate: number | null;
  topModel: string | null;
  lastActive: UnixSeconds | null;
  /** Daily cost over the requested range, oldest first, zero-filled. */
  sparkline: DailyCostPoint[];
}

export interface ProjectsResponse extends TimeRange {
  projects: ProjectRow[];
}

export type SessionSort = 'cost' | 'recent';

export interface SessionRow extends UsageTotals {
  sessionId: string;
  project: string;
  projectLabel: string;
  title: string | null;
  gitBranch: string | null;
  models: string[];
  firstTs: UnixSeconds;
  lastTs: UnixSeconds;
  durationSeconds: number;
  agentCount: number;
  costStateUsd: number | null;
  /** costStateUsd - costUsd (title generation, classifiers, compaction); null without cost-state. */
  untrackedOverheadUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

export interface SessionsResponse extends TimeRange {
  total: number;
  limit: number;
  offset: number;
  sort: SessionSort;
  sessions: SessionRow[];
}

export interface KeyedTotals extends UsageTotals {
  key: string;
}

export interface SessionDetail {
  session: SessionRow;
  /** Hourly series of `metric` cost by model. */
  byModel: TimeseriesSeries[];
  /** Hourly series of cost by agent kind. */
  byAgentKind: TimeseriesSeries[];
  totals: {
    all: UsageTotals;
    byModel: KeyedTotals[];
    byAgentKind: KeyedTotals[];
  };
}

export interface ModelRow extends UsageTotals {
  model: string;
  /** Normalized pricing family (e.g. `claude-opus-5-5`), or the cleaned id when unpriced. */
  family: string;
  priced: boolean;
  cacheHitRate: number | null;
  cacheSavingsUsd: number;
  /** 0-1 share of total cost in range. */
  costShare: number;
  /** 0-1 share of total tokens in range. */
  tokenShare: number;
}

export interface ModelsResponse extends TimeRange {
  models: ModelRow[];
}

export interface HeatmapCell {
  /** Day of week in tz, 0 = Sunday. */
  dow: number;
  /** Hour of day in tz, 0-23. */
  hour: number;
  costUsd: number;
  tokens: number;
  requests: number;
}

export interface CalendarDay {
  day: DayKey;
  costUsd: number;
  tokens: number;
  requests: number;
}

export interface HeatmapResponse extends TimeRange {
  weeks: number;
  tz: string;
  /** Sparse: only cells with activity. */
  grid: HeatmapCell[];
  /** Every day in range, oldest first, zero-filled. */
  calendar: CalendarDay[];
}

/** One OTel `claude_code.api_request` event (live_requests row). Provisional: no 5m/1h split from OTel itself. */
export interface LiveRequest {
  requestId: string;
  ts: UnixSeconds;
  sessionId: string | null;
  model: string | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  costUsd: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  speed: string | null;
  effort: string | null;
  querySource: string | null;
}

export interface LiveMinutePoint {
  /** Minute start, unix seconds. */
  t: UnixSeconds;
  requests: number;
  costUsd: number;
  tokens: number;
}

export interface LiveResponse {
  minutes: number;
  perMinute: LiveMinutePoint[];
  /** Newest first, at most 50. */
  recent: LiveRequest[];
  lastReceivedTs: UnixSeconds | null;
}

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface SyncRun {
  ts: UnixSeconds;
  device: string | null;
  rows: number | null;
  pending: number | null;
  version: string | null;
  errors: string[];
}

export interface StatusResponse {
  version: string;
  syncRuns: SyncRun[];
  /** Approximate row counts per D1 table. */
  tableRows: Record<string, number>;
  unpricedModels: string[];
  otelLastReceivedTs: UnixSeconds | null;
  outputIncomplete: {
    /** From the latest sync run's stats. */
    requests: number;
    reportedTs: UnixSeconds | null;
  };
  /** Approximate D1 rows written since UTC midnight (free quota: 100k/day). */
  d1RowsWrittenToday: number;
  freeTier: {
    rowsWrittenPerDay: number;
    rowsReadPerDay: number;
    requestsPerDay: number;
  };
}

export interface AlertThresholds {
  /** Percent thresholds, ascending, e.g. [75, 90]. */
  fiveHour: number[];
  weekly: number[];
}

export interface Settings {
  /** 0 = off */
  dailyBudgetUsd: number;
  alertThresholds: AlertThresholds;
  weeklyPaceAlert: boolean;
  staleSyncMinutes: number;
  ntfyEnabled: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  dailyBudgetUsd: 0,
  alertThresholds: Object.freeze({ fiveHour: [75, 90], weekly: [75, 90] }) as AlertThresholds,
  weeklyPaceAlert: true,
  staleSyncMinutes: 60,
  ntfyEnabled: true,
});

/** Body of PUT /api/settings: any subset; the response is the full Settings. */
export type SettingsUpdate = Partial<Settings>;

/** GET/PUT /api/settings response: the stored settings plus read-only server facts. */
export interface SettingsResponse extends Settings {
  /** False when the NTFY_TOPIC secret is unset or blank, so no alert can be delivered. */
  ntfyConfigured: boolean;
}

export interface AlertTestResponse {
  ok: boolean;
  sent: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Local files (~/.claude-usage/)
// ---------------------------------------------------------------------------

/** `~/.claude-usage/config.json`, written by `ccu install`. */
export interface Config {
  apiUrl: string;
  writeToken: string;
  readToken?: string;
  /** IANA timezone, e.g. America/Denver. */
  tz: string;
  deviceName: string;
  ntfyTopic?: string;
  /** Free-tier guard: max rows uploaded per sync run. Default 15000. */
  maxRowsPerRun?: number;
  /** Free-tier guard: max rows uploaded per UTC day (D1 allows 100k writes/day). Default 80000. */
  maxRowsPerDay?: number;
  /** Override for ~/.claude (tests, unusual installs). */
  claudeDir?: string;
}

export const DEFAULT_MAX_ROWS_PER_RUN = 15000;
export const DEFAULT_MAX_ROWS_PER_DAY = 80000;

export interface CacheLimitWindow {
  key: LimitWindowKey;
  label: string;
  /** 0-100 */
  utilization: number;
  resetsAt: UnixSeconds;
  severity: string | null;
}

export interface CacheError {
  ts: UnixSeconds;
  /** Which step failed, e.g. "usageApi", "upload", "transcripts", "config". */
  source: string;
  /** Token-free message. */
  message: string;
}

/** `~/.claude-usage/cache.json`, written by every sync run, read by the statusline (no network). */
export interface CacheFile {
  version: 1;
  /** When this file was written. */
  updatedTs: UnixSeconds;
  /** Last successful upload; null if never. */
  lastSyncTs: UnixSeconds | null;
  tz: string;
  limits: {
    /** When the windows were fetched from the usage API; null if never. */
    fetchedTs: UnixSeconds | null;
    windows: CacheLimitWindow[];
    extraUsageEnabled?: boolean | null;
  };
  today: {
    day: DayKey;
    costUsd: number;
    tokens: number;
    requests: number;
  };
  /** API-equivalent USD per hour over the last 60 minutes. */
  burnRatePerHour: number;
  /** Rows not yet uploaded (backfill in progress). */
  pending: number;
  errors: CacheError[];
}

/** Route paths, so clients and the worker agree. */
export const API_ROUTES = {
  ingestUsage: '/api/ingest/usage',
  ingestLimits: '/api/ingest/limits',
  ingestDailyLegacy: '/api/ingest/daily-legacy',
  otlpLogs: '/v1/logs',
  otlpMetrics: '/v1/metrics',
  summary: '/api/summary',
  timeseries: '/api/timeseries',
  limits: '/api/limits',
  projects: '/api/projects',
  sessions: '/api/sessions',
  models: '/api/models',
  heatmap: '/api/heatmap',
  live: '/api/live',
  health: '/api/health',
  status: '/api/status',
  settings: '/api/settings',
  alertsTest: '/api/alerts/test',
} as const;
