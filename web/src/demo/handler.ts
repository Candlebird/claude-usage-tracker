import {
  API_ROUTES,
  DAY,
  DEFAULT_SETTINGS,
  FIVE_HOUR_SECONDS,
  HOUR,
  MINUTE,
  SEVEN_DAY_SECONDS,
  TOKEN_TYPES,
  addUsage,
  bucketStart,
  cacheHitRate,
  cacheSavings,
  costOf,
  dayKey,
  dayKeyStart,
  dayOfWeek,
  dayStart,
  daysInRange,
  emptyTotals,
  hourOfDay,
  isPriced,
  normalizeModel,
  projectWindow,
  totalTokens,
  type AlertTestResponse,
  type CalendarDay,
  type FiveHourBlock,
  type HealthResponse,
  type HeatmapCell,
  type HeatmapResponse,
  type HourlyBucket,
  type KeyedTotals,
  type LimitHistoryPoint,
  type LimitHistorySeries,
  type LimitWindowStatus,
  type LiveMinutePoint,
  type LiveResponse,
  type LimitsResponse,
  type ModelsResponse,
  type PeriodKpis,
  type ProjectsResponse,
  type SessionDetail,
  type SessionRow,
  type SessionSort,
  type SessionsResponse,
  type Settings,
  type SettingsResponse,
  type SettingsUpdate,
  type StatusResponse,
  type SummaryResponse,
  type TimeseriesBucket,
  type TimeseriesGroup,
  type TimeseriesMetric,
  type TimeseriesResponse,
  type TimeseriesSeries,
  type TokenType,
  type UnixSeconds,
  type UsageTotals,
} from '@ccu/shared';
import {
  DEMO_DEVICE,
  DEMO_VERSION,
  FABLE_WEEKLY_USD_PER_PCT,
  WEEKLY_USD_PER_PCT,
  buildDataset,
  costBetween,
  weeklyResetAfter,
  type DemoBlock,
  type DemoDataset,
} from './dataset';

/** Thrown for routes or ids the demo does not know; mirrors an HTTP status. */
export class DemoHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DemoRequest {
  method?: string;
  path: string;
  query?: URLSearchParams;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Dataset cache and mutable demo settings
// ---------------------------------------------------------------------------

let cached: { key: string; data: DemoDataset } | null = null;
let demoSettings: Settings = { ...DEFAULT_SETTINGS, alertThresholds: { fiveHour: [75, 90], weekly: [75, 90] }, dailyBudgetUsd: 60 };

export function demoDataset(now: UnixSeconds, tz: string): DemoDataset {
  const minute = Math.floor(now / MINUTE) * MINUTE;
  const key = `${minute}|${tz}`;
  if (cached?.key !== key) cached = { key, data: buildDataset(minute, tz) };
  return cached.data;
}

/** Restores the demo's in-memory settings (tests). */
export function resetDemoState(): void {
  cached = null;
  demoSettings = { ...DEFAULT_SETTINGS, alertThresholds: { fiveHour: [75, 90], weekly: [75, 90] }, dailyBudgetUsd: 60 };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function inRange(b: HourlyBucket, from: UnixSeconds, to: UnixSeconds): boolean {
  return b.hour + HOUR > from && b.hour < to;
}

function totalsOf(bs: readonly HourlyBucket[]): UsageTotals {
  const t = emptyTotals();
  for (const b of bs) {
    addUsage(t, b);
    t.requests += b.requests;
    t.costUsd += b.costUsd;
  }
  t.totalTokens = totalTokens(t);
  return t;
}

function savingsOf(bs: readonly HourlyBucket[]): number {
  return bs.reduce((s, b) => s + cacheSavings(b, b.model), 0);
}

function groupBy<K>(bs: readonly HourlyBucket[], key: (b: HourlyBucket) => K): Map<K, HourlyBucket[]> {
  const m = new Map<K, HourlyBucket[]>();
  for (const b of bs) {
    const k = key(b);
    const arr = m.get(k);
    if (arr) arr.push(b);
    else m.set(k, [b]);
  }
  return m;
}

function keyedTotals(bs: readonly HourlyBucket[], key: (b: HourlyBucket) => string): KeyedTotals[] {
  return [...groupBy(bs, key)].map(([k, g]) => ({ key: k, ...totalsOf(g) })).sort((a, b) => b.costUsd - a.costUsd);
}

function periodKpis(d: DemoDataset, from: UnixSeconds, to: UnixSeconds): PeriodKpis {
  const bs = d.buckets.filter((b) => inRange(b, from, to));
  const t = totalsOf(bs);
  return {
    ...t,
    sessions: new Set(bs.map((b) => b.sessionId)).size,
    cacheHitRate: cacheHitRate(t),
    cacheSavingsUsd: savingsOf(bs),
  };
}

function num(q: URLSearchParams | undefined, name: string, fallback: number): number {
  const raw = q?.get(name);
  const v = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function rangeOf(q: URLSearchParams | undefined, now: UnixSeconds): { from: UnixSeconds; to: UnixSeconds } {
  const to = Math.min(num(q, 'to', now), now);
  const from = num(q, 'from', to - 7 * DAY);
  return { from: Math.min(from, to), to };
}

function severityOf(util: number): string {
  return util >= 90 ? 'critical' : util >= 75 ? 'warning' : 'normal';
}

// ---------------------------------------------------------------------------
// Limit windows
// ---------------------------------------------------------------------------

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour session',
  seven_day: 'Weekly (all models)',
  'seven_day:fable': 'Weekly (Fable)',
};
export const DEMO_WINDOW_KEYS = Object.keys(WINDOW_LABELS);

function blockAt(blocks: readonly DemoBlock[], ts: UnixSeconds): DemoBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.start <= ts && ts < b.end) return b;
    if (b.end <= ts) return null;
  }
  return null;
}

/** Utilization of a window as observed at `ts`. */
function windowValueAt(d: DemoDataset, key: string, ts: UnixSeconds): { utilization: number; resetsAt: UnixSeconds } {
  if (key === 'five_hour') {
    const b = blockAt(d.blocks, ts);
    if (!b) return { utilization: 0, resetsAt: Math.ceil((ts + FIVE_HOUR_SECONDS) / MINUTE) * MINUTE };
    return { utilization: Math.min(100, costBetween(d.hourCost, b.start, ts) / b.usdPerPct), resetsAt: b.end };
  }
  const resetsAt = weeklyResetAfter(ts);
  const start = resetsAt - SEVEN_DAY_SECONDS;
  const fable = key === 'seven_day:fable';
  const cost = costBetween(d.hourCost, start, ts, fable ? 'fable' : 'all');
  return { utilization: Math.min(100, cost / (fable ? FABLE_WEEKLY_USD_PER_PCT : WEEKLY_USD_PER_PCT)), resetsAt };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function currentLimits(d: DemoDataset): LimitWindowStatus[] {
  // Snapshots arrive with each 5-minute sync.
  const snapshotTs = d.now - (d.now % (5 * MINUTE));
  const rows = DEMO_WINDOW_KEYS.map((key): LimitWindowStatus => {
    const v = windowValueAt(d, key, snapshotTs);
    const utilization = round1(v.utilization);
    const len = key === 'five_hour' ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS;
    const p = projectWindow(utilization, v.resetsAt, len, d.now);
    return {
      key,
      label: WINDOW_LABELS[key]!,
      utilization,
      resetsAt: v.resetsAt,
      severity: severityOf(utilization),
      snapshotTs,
      windowSeconds: len,
      elapsedFraction: p.elapsedFraction,
      pace: p.pace,
      projectedFullAt: p.projectedFullAt,
      projectedAtReset: p.projectedAtReset,
    };
  });
  return rows;
}

function limitHistory(d: DemoDataset, from: UnixSeconds, to: UnixSeconds): LimitHistorySeries[] {
  const step = to - from > 14 * DAY ? 3 * HOUR : HOUR;
  return DEMO_WINDOW_KEYS.map((key) => {
    const points: LimitHistoryPoint[] = [];
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
      const v = windowValueAt(d, key, t);
      const utilization = round1(v.utilization);
      points.push({ ts: t, utilization, resetsAt: v.resetsAt, severity: severityOf(utilization) });
    }
    return { key, label: WINDOW_LABELS[key]!, points };
  });
}

function fiveHourBlocks(d: DemoDataset, from: UnixSeconds, to: UnixSeconds): FiveHourBlock[] {
  return d.blocks
    .filter((b) => b.end > from && b.start < to)
    .map((b) => {
      const end = Math.min(b.end, d.now);
      const bs = d.buckets.filter((x) => x.hour + HOUR > b.start && x.hour < end);
      const cost = costBetween(d.hourCost, b.start, end);
      const peakUtilization = round1(Math.min(100, cost / b.usdPerPct));
      const t = totalsOf(bs);
      return {
        start: b.start,
        end: b.end,
        peakUtilization,
        costUsd: cost,
        tokens: t.totalTokens,
        requests: t.requests,
        costPerPercent: peakUtilization > 0 ? cost / peakUtilization : null,
        active: d.now >= b.start && d.now < b.end,
      };
    })
    .sort((a, b) => b.start - a.start);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

function summary(d: DemoDataset): SummaryResponse {
  const live = d.live.filter((r) => r.ts > d.now - HOUR);
  const liveCost = live.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const liveTokens = live.reduce((s, r) => s + (r.input ?? 0) + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite5m ?? 0) + (r.cacheWrite1h ?? 0), 0);
  const lastSyncTs = d.now - (d.now % (5 * MINUTE)) + 12;
  const syncTs = lastSyncTs > d.now ? lastSyncTs - 5 * MINUTE : lastSyncTs;
  return {
    generatedAt: d.now,
    tz: d.tz,
    today: periodKpis(d, dayStart(d.now, d.tz), d.now),
    last7d: periodKpis(d, d.now - 7 * DAY, d.now),
    last30d: periodKpis(d, d.now - 30 * DAY, d.now),
    burnRate: { windowMinutes: 60, costPerHour: liveCost, tokensPerMinute: liveTokens / 60, requests: live.length, source: 'merged' },
    limits: currentLimits(d),
    sync: { lastSyncTs: syncTs, ageSeconds: d.now - syncTs, pending: 0, device: DEMO_DEVICE },
    unpricedModels: [],
    hasUnpriced: false,
    dailyBudgetUsd: demoSettings.dailyBudgetUsd,
  };
}

function seriesKey(b: HourlyBucket, group: TimeseriesGroup): string {
  if (group === 'model') return b.model;
  if (group === 'project') return b.project;
  return b.agentKind;
}

/** Per-type tokens or cost of a bucket (cost priced as averaged requests). */
function typeValues(b: HourlyBucket, metric: TimeseriesMetric): Record<TokenType, number> {
  const out = {} as Record<TokenType, number>;
  if (metric === 'tokens') {
    for (const t of TOKEN_TYPES) out[t] = b[t];
    return out;
  }
  const n = Math.max(1, b.requests);
  const norm = normalizeModel(b.model);
  for (const t of TOKEN_TYPES) {
    const one = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
    one[t] = b[t] / n;
    out[t] = norm.priced ? costOf(one, b.model) * n : 0;
  }
  return out;
}

function timeseries(d: DemoDataset, q: URLSearchParams | undefined): TimeseriesResponse {
  const { from, to } = rangeOf(q, d.now);
  const bucket = (q?.get('bucket') === 'day' ? 'day' : q?.get('bucket') === 'hour' ? 'hour' : to - from > 3 * DAY ? 'day' : 'hour') as TimeseriesBucket;
  const groupRaw = q?.get('group');
  const group: TimeseriesGroup = groupRaw === 'project' || groupRaw === 'agent_kind' || groupRaw === 'type' ? groupRaw : 'model';
  const metricRaw = q?.get('metric');
  const metric: TimeseriesMetric = metricRaw === 'tokens' || metricRaw === 'requests' ? metricRaw : 'cost';
  const tz = q?.get('tz') || d.tz;
  const project = q?.get('project');
  const bs = d.buckets.filter((b) => inRange(b, from, to) && (!project || b.project === project));
  return { from, to, bucket, group, metric, tz, series: buildSeries(bs, from, to, bucket, group, metric, tz, d) };
}

function bucketStarts(from: UnixSeconds, to: UnixSeconds, bucket: TimeseriesBucket, tz: string): UnixSeconds[] {
  if (bucket === 'day') return daysInRange(from, to, tz).map((day) => dayKeyStart(day, tz));
  const out: UnixSeconds[] = [];
  for (let t = bucketStart(from, 'hour', tz); t < to; t += HOUR) out.push(t);
  return out;
}

function buildSeries(
  bs: readonly HourlyBucket[],
  from: UnixSeconds,
  to: UnixSeconds,
  bucket: TimeseriesBucket,
  group: TimeseriesGroup,
  metric: TimeseriesMetric,
  tz: string,
  d: DemoDataset,
): TimeseriesSeries[] {
  const starts = bucketStarts(from, to, bucket, tz);
  const index = new Map(starts.map((t, i) => [t, i]));
  const sums = new Map<string, number[]>();
  const add = (key: string, t: UnixSeconds, v: number) => {
    const i = index.get(bucketStart(t, bucket, tz));
    if (i == null) return;
    let arr = sums.get(key);
    if (!arr) sums.set(key, (arr = new Array<number>(starts.length).fill(0)));
    arr[i]! += v;
  };
  for (const b of bs) {
    if (group === 'type') {
      if (metric === 'requests') continue;
      const v = typeValues(b, metric);
      for (const t of TOKEN_TYPES) add(t, b.hour, v[t]);
    } else {
      add(seriesKey(b, group), b.hour, metric === 'cost' ? b.costUsd : metric === 'tokens' ? totalTokens(b) : b.requests);
    }
  }
  const labels = new Map(d.projects.map((p) => [p.project, p.label]));
  return [...sums]
    .map(([key, vals]) => ({
      key,
      ...(group === 'project' ? { label: labels.get(key) ?? key } : {}),
      points: vals.map((v, i): [number, number] => [starts[i]!, v]),
    }))
    .sort((a, b) => sumPoints(b.points) - sumPoints(a.points));
}

function sumPoints(points: readonly [number, number][]): number {
  return points.reduce((s, p) => s + p[1], 0);
}

function limits(d: DemoDataset, q: URLSearchParams | undefined): LimitsResponse {
  const { from, to } = rangeOf(q, d.now);
  return {
    from,
    to,
    windows: limitHistory(d, from, to),
    hits: d.hits.filter((h) => h.ts >= from && h.ts <= to).sort((a, b) => b.ts - a.ts),
    blocks: fiveHourBlocks(d, from, to),
    current: currentLimits(d),
  };
}

function dailySparkline(bs: readonly HourlyBucket[], from: UnixSeconds, to: UnixSeconds, tz: string) {
  const days = daysInRange(from, to, tz);
  const idx = new Map(days.map((day, i) => [day, i]));
  const vals = new Array<number>(days.length).fill(0);
  for (const b of bs) {
    const i = idx.get(dayKey(b.hour, tz));
    if (i != null) vals[i]! += b.costUsd;
  }
  return days.map((day, i) => ({ day, costUsd: vals[i]! }));
}

function projects(d: DemoDataset, q: URLSearchParams | undefined): ProjectsResponse {
  const { from, to } = rangeOf(q, d.now);
  const tz = q?.get('tz') || d.tz;
  const bs = d.buckets.filter((b) => inRange(b, from, to));
  const rows = [...groupBy(bs, (b) => b.project)].map(([project, g]) => {
    const meta = d.projects.find((p) => p.project === project);
    const t = totalsOf(g);
    const byModel = keyedTotals(g, (b) => b.model);
    return {
      ...t,
      project,
      label: meta?.label ?? project,
      path: meta?.path ?? null,
      sessions: new Set(g.map((b) => b.sessionId)).size,
      cacheHitRate: cacheHitRate(t),
      topModel: byModel[0]?.key ?? null,
      lastActive: Math.min(d.now, Math.max(...g.map((b) => d.sessions.find((s) => s.sessionId === b.sessionId)?.lastTs ?? b.hour))),
      sparkline: dailySparkline(g, from, to, tz),
    };
  });
  return { from, to, projects: rows.sort((a, b) => b.costUsd - a.costUsd) };
}

function sessionRow(d: DemoDataset, sessionId: string, bs: readonly HourlyBucket[]): SessionRow | null {
  const meta = d.sessions.find((s) => s.sessionId === sessionId);
  if (!meta) return null;
  const t = totalsOf(bs);
  return {
    ...t,
    sessionId,
    project: meta.project,
    projectLabel: d.projects.find((p) => p.project === meta.project)?.label ?? meta.project,
    title: meta.title ?? null,
    gitBranch: meta.gitBranch ?? null,
    models: meta.models,
    firstTs: meta.firstTs,
    lastTs: meta.lastTs,
    durationSeconds: meta.lastTs - meta.firstTs,
    agentCount: meta.agentCount,
    costStateUsd: meta.costStateUsd ?? null,
    untrackedOverheadUsd: meta.costStateUsd == null ? null : meta.costStateUsd - t.costUsd,
    linesAdded: meta.linesAdded ?? null,
    linesRemoved: meta.linesRemoved ?? null,
  };
}

function sessions(d: DemoDataset, q: URLSearchParams | undefined): SessionsResponse {
  const { from, to } = rangeOf(q, d.now);
  const project = q?.get('project') || null;
  const sort: SessionSort = q?.get('sort') === 'cost' ? 'cost' : 'recent';
  const limit = Math.max(1, Math.min(200, num(q, 'limit', 50)));
  const offset = Math.max(0, num(q, 'offset', 0));
  const bs = d.buckets.filter((b) => inRange(b, from, to) && (!project || b.project === project));
  const rows = [...groupBy(bs, (b) => b.sessionId)]
    .map(([id, g]) => sessionRow(d, id, g))
    .filter((r): r is SessionRow => r != null)
    .sort((a, b) => (sort === 'cost' ? b.costUsd - a.costUsd : b.lastTs - a.lastTs));
  return { from, to, total: rows.length, limit, offset, sort, sessions: rows.slice(offset, offset + limit) };
}

function sessionDetail(d: DemoDataset, id: string): SessionDetail {
  const bs = d.buckets.filter((b) => b.sessionId === id);
  const row = bs.length ? sessionRow(d, id, bs) : null;
  if (!row) throw new DemoHttpError(404, 'session not found');
  const from = Math.floor(row.firstTs / HOUR) * HOUR;
  const to = Math.max(row.lastTs, from + HOUR);
  return {
    session: row,
    byModel: buildSeries(bs, from, to, 'hour', 'model', 'cost', 'UTC', d),
    byAgentKind: buildSeries(bs, from, to, 'hour', 'agent_kind', 'cost', 'UTC', d),
    totals: {
      all: totalsOf(bs),
      byModel: keyedTotals(bs, (b) => b.model),
      byAgentKind: keyedTotals(bs, (b) => b.agentKind),
    },
  };
}

function models(d: DemoDataset, q: URLSearchParams | undefined): ModelsResponse {
  const { from, to } = rangeOf(q, d.now);
  const bs = d.buckets.filter((b) => inRange(b, from, to));
  const all = totalsOf(bs);
  const rows = [...groupBy(bs, (b) => b.model)].map(([model, g]) => {
    const t = totalsOf(g);
    const norm = normalizeModel(model);
    return {
      ...t,
      model,
      family: norm.family,
      priced: isPriced(model),
      cacheHitRate: cacheHitRate(t),
      cacheSavingsUsd: savingsOf(g),
      costShare: all.costUsd > 0 ? t.costUsd / all.costUsd : 0,
      tokenShare: all.totalTokens > 0 ? t.totalTokens / all.totalTokens : 0,
    };
  });
  return { from, to, models: rows.sort((a, b) => b.costUsd - a.costUsd) };
}

function heatmap(d: DemoDataset, q: URLSearchParams | undefined): HeatmapResponse {
  const weeks = Math.max(1, Math.min(13, Math.round(num(q, 'weeks', 12))));
  const tz = q?.get('tz') || d.tz;
  const to = d.now;
  const from = dayStart(to - (weeks * 7 - 1) * DAY, tz);
  const bs = d.buckets.filter((b) => inRange(b, from, to));
  const cells = new Map<string, HeatmapCell>();
  for (const b of bs) {
    const dow = dayOfWeek(b.hour, tz);
    const hour = hourOfDay(b.hour, tz);
    const k = `${dow}:${hour}`;
    const c = cells.get(k) ?? { dow, hour, costUsd: 0, tokens: 0, requests: 0 };
    c.costUsd += b.costUsd;
    c.tokens += totalTokens(b);
    c.requests += b.requests;
    cells.set(k, c);
  }
  const days = daysInRange(from, to, tz);
  const cal = new Map<string, CalendarDay>(days.map((day) => [day, { day, costUsd: 0, tokens: 0, requests: 0 }]));
  for (const b of bs) {
    const c = cal.get(dayKey(b.hour, tz));
    if (!c) continue;
    c.costUsd += b.costUsd;
    c.tokens += totalTokens(b);
    c.requests += b.requests;
  }
  return {
    from,
    to,
    weeks,
    tz,
    grid: [...cells.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour),
    calendar: days.map((day) => cal.get(day)!),
  };
}

function live(d: DemoDataset, q: URLSearchParams | undefined): LiveResponse {
  const minutes = Math.max(1, Math.min(60, Math.round(num(q, 'minutes', 60))));
  const first = Math.floor(d.now / MINUTE) * MINUTE - (minutes - 1) * MINUTE;
  const perMinute: LiveMinutePoint[] = [];
  for (let t = first; t <= d.now; t += MINUTE) perMinute.push({ t, requests: 0, costUsd: 0, tokens: 0 });
  const recent = d.live.filter((r) => r.ts >= first);
  for (const r of recent) {
    const p = perMinute[Math.floor((r.ts - first) / MINUTE)];
    if (!p) continue;
    p.requests += 1;
    p.costUsd += r.costUsd ?? 0;
    p.tokens += (r.input ?? 0) + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite5m ?? 0) + (r.cacheWrite1h ?? 0);
  }
  return { minutes, perMinute, recent: recent.slice(0, 50), lastReceivedTs: recent[0]?.ts ?? null };
}

function status(d: DemoDataset): StatusResponse {
  const runs = Array.from({ length: 12 }, (_, i) => {
    const ts = d.now - (d.now % (5 * MINUTE)) - i * 5 * MINUTE + 12;
    return { ts: ts > d.now ? ts - 5 * MINUTE : ts, device: DEMO_DEVICE, rows: i === 0 ? 7 : 3 + (i % 4), pending: 0, version: DEMO_VERSION, errors: [] as string[] };
  });
  return {
    version: DEMO_VERSION,
    syncRuns: runs,
    tableRows: {
      usage_hourly: d.buckets.length,
      sessions: d.sessions.length,
      projects: d.projects.length,
      limit_snapshots: 90 * 24 * 3,
      limit_hits: d.hits.length,
      live_requests: d.live.length,
      sync_runs: 288,
    },
    unpricedModels: [],
    otelLastReceivedTs: d.live[0]?.ts ?? null,
    outputIncomplete: { requests: 2, reportedTs: runs[0]!.ts },
    d1RowsWrittenToday: 4200 + Math.floor((d.now % DAY) / 30),
    freeTier: { rowsWrittenPerDay: 100_000, rowsReadPerDay: 5_000_000, requestsPerDay: 100_000 },
  };
}

/** The demo has no ntfy topic: the test alert never sends, and the card says so. */
const demoSettingsResponse = (): SettingsResponse => ({ ...demoSettings, ntfyConfigured: false });

function putSettings(body: unknown): SettingsResponse {
  const patch = (body ?? {}) as SettingsUpdate;
  demoSettings = {
    ...demoSettings,
    ...patch,
    alertThresholds: { ...demoSettings.alertThresholds, ...(patch.alertThresholds ?? {}) },
  };
  return demoSettingsResponse();
}

/** Serves every read route from the synthetic dataset. Writes only touch in-memory settings. */
export function handleDemoRequest(req: DemoRequest, now: UnixSeconds, tz: string): unknown {
  const method = (req.method ?? 'GET').toUpperCase();
  const q = req.query;
  const d = demoDataset(now, q?.get('tz') || tz);
  const path = req.path.replace(/\/+$/, '');
  if (path === API_ROUTES.health) return { ok: true, version: DEMO_VERSION } satisfies HealthResponse;
  if (path === API_ROUTES.settings) {
    if (method === 'PUT') return putSettings(req.body);
    return demoSettingsResponse();
  }
  if (path === API_ROUTES.alertsTest && method === 'POST') return { ok: true, sent: false, error: 'demo mode: nothing sent' } satisfies AlertTestResponse;
  if (method !== 'GET') throw new DemoHttpError(405, 'method not allowed');
  switch (path) {
    case API_ROUTES.summary:
      return summary(d);
    case API_ROUTES.timeseries:
      return timeseries(d, q);
    case API_ROUTES.limits:
      return limits(d, q);
    case API_ROUTES.projects:
      return projects(d, q);
    case API_ROUTES.sessions:
      return sessions(d, q);
    case API_ROUTES.models:
      return models(d, q);
    case API_ROUTES.heatmap:
      return heatmap(d, q);
    case API_ROUTES.live:
      return live(d, q);
    case API_ROUTES.status:
      return status(d);
  }
  if (path.startsWith(API_ROUTES.sessions + '/')) return sessionDetail(d, decodeURIComponent(path.slice(API_ROUTES.sessions.length + 1)));
  throw new DemoHttpError(404, 'not found');
}
