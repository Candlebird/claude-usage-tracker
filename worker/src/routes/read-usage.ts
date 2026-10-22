// Range reads over usage_hourly: timeseries, projects, models, heatmap.
// Every query is a range scan on the hour primary-key prefix.
import {
  cacheHitRate,
  cacheSavings,
  DAY,
  emptyTotals,
  HOUR,
  hourStartUtc,
  normalizeModel,
  priceFor,
  TOKEN_TYPES,
  type CalendarDay,
  type HeatmapCell,
  type HeatmapResponse,
  type ModelRow,
  type ModelsResponse,
  type ProjectRow,
  type ProjectsResponse,
  type TimeseriesBucket,
  type TimeseriesGroup,
  type TimeseriesMetric,
  type TimeseriesResponse,
  type TimeseriesSeries,
  type TokenType,
  type UnixSeconds,
  type UsageTotals,
} from '@ccu/shared';
import type { Env } from '../db.js';
import { HttpError } from '../http.js';
import { addTotals, round6, share, sumColumns, totalsOf, type SumRow } from './read-agg.js';
import { DayIndex, HOUR_MID, localDayStartBack } from './read-days.js';

/** Hour buckets over longer ranges would return too many points. */
export const MAX_HOURLY_RANGE = 62 * DAY;

/** WHERE clause for hour buckets overlapping [?1, ?2]. */
const HOUR_RANGE = 'hour > ?1 - 3600 AND hour <= ?2';

// ---------------------------------------------------------------------------
// Timeseries
// ---------------------------------------------------------------------------

const GROUP_COLUMN: Record<Exclude<TimeseriesGroup, 'type'>, string> = {
  model: 'model',
  project: 'project',
  agent_kind: 'agent_kind',
};

const TYPE_COLUMN: Record<TokenType, keyof SumRow> = {
  input: 'input',
  output: 'output',
  cacheRead: 'cacheRead',
  cacheWrite5m: 'cacheWrite5m',
  cacheWrite1h: 'cacheWrite1h',
};

export interface TimeseriesQuery {
  from: UnixSeconds;
  to: UnixSeconds;
  bucket: TimeseriesBucket;
  group: TimeseriesGroup;
  metric: TimeseriesMetric;
  tz: string;
  project: string | null;
}

interface GroupedRow extends SumRow {
  hour: number;
  k: string;
}

function metricOf(r: SumRow, metric: TimeseriesMetric): number {
  if (metric === 'cost') return r.costUsd;
  if (metric === 'requests') return r.requests;
  return r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
}

/**
 * Per-type values of one (hour, model) row. Cost per type uses the model's base prices,
 * scaled so the parts add up to the stored cost (which already includes tiers and fast mode).
 */
export function typeValues(r: SumRow, model: string, metric: TimeseriesMetric): [string, number][] {
  if (metric === 'requests') return [['requests', r.requests]];
  if (metric === 'tokens') return TOKEN_TYPES.map((t) => [t, r[TYPE_COLUMN[t]]]);
  const p = priceFor(model);
  if (!p) return TOKEN_TYPES.map((t) => [t, 0]);
  const est = TOKEN_TYPES.map((t): [string, number] => [t, (r[TYPE_COLUMN[t]] * p[t]) / 1e6]);
  const sum = est.reduce((a, [, v]) => a + v, 0);
  const scale = sum > 0 ? r.costUsd / sum : 0;
  return est.map(([t, v]) => [t, v * scale]);
}

class SeriesBuilder {
  private readonly values = new Map<string, number[]>();

  constructor(private readonly size: number) {}

  add(key: string, i: number, v: number): void {
    if (i < 0 || i >= this.size || v === 0) {
      if (!this.values.has(key) && i >= 0 && i < this.size) this.values.set(key, new Array<number>(this.size).fill(0));
      return;
    }
    let arr = this.values.get(key);
    if (!arr) this.values.set(key, (arr = new Array<number>(this.size).fill(0)));
    arr[i]! += v;
  }

  build(times: UnixSeconds[], labels: Map<string, string>, round: (n: number) => number): TimeseriesSeries[] {
    const out = [...this.values.entries()].map(([key, arr]) => ({ key, arr, total: arr.reduce((a, b) => a + b, 0) }));
    out.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    return out.map(({ key, arr }) => {
      const s: TimeseriesSeries = { key, points: arr.map((v, i) => [times[i]!, round(v)]) };
      const label = labels.get(key);
      if (label && label !== key) s.label = label;
      return s;
    });
  }
}

export async function buildTimeseries(env: Env, q: TimeseriesQuery): Promise<TimeseriesResponse> {
  if (q.bucket === 'hour' && q.to - q.from > MAX_HOURLY_RANGE) throw new HttpError(400, 'hour buckets are limited to 62 days; use bucket=day');
  const col = q.group === 'type' ? 'model' : GROUP_COLUMN[q.group];
  const projectFilter = q.project ? ' AND project = ?3' : '';
  const sql = `SELECT hour, ${col} AS k, ${sumColumns()} FROM usage_hourly WHERE ${HOUR_RANGE}${projectFilter} GROUP BY hour, k`;
  const binds: (string | number)[] = [q.from, q.to];
  if (q.project) binds.push(q.project);

  const stmts = [env.DB.prepare(sql).bind(...binds)];
  if (q.group === 'project') stmts.push(env.DB.prepare('SELECT project, label FROM projects'));
  const [rowsRes, labelRes] = await env.DB.batch(stmts);
  const rows = (rowsRes!.results ?? []) as GroupedRow[];
  const labels = new Map<string, string>();
  for (const r of (labelRes?.results ?? []) as { project: string; label: string }[]) labels.set(r.project, r.label);

  let times: UnixSeconds[];
  let indexOf: (hour: number) => number;
  if (q.bucket === 'hour') {
    const first = hourStartUtc(q.from);
    const count = Math.floor((hourStartUtc(q.to) - first) / HOUR) + 1;
    times = Array.from({ length: count }, (_, i) => first + i * HOUR);
    indexOf = (hour) => (hour - first) / HOUR;
  } else {
    const days = new DayIndex(q.from, q.to, q.tz);
    times = days.starts.slice(0, -1);
    indexOf = (hour) => days.indexOfHour(hour);
  }

  const builder = new SeriesBuilder(times.length);
  for (const r of rows) {
    const i = indexOf(r.hour);
    if (q.group === 'type') {
      for (const [k, v] of typeValues(r, r.k, q.metric)) builder.add(k, i, v);
    } else {
      builder.add(r.k, i, metricOf(r, q.metric));
    }
  }
  const round = q.metric === 'cost' ? round6 : Math.round;
  return {
    from: q.from,
    to: q.to,
    bucket: q.bucket,
    group: q.group,
    metric: q.metric,
    tz: q.tz,
    series: builder.build(times, labels, round),
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const PROJECT_HOURS_SQL = `SELECT project, model, hour, ${sumColumns()} FROM usage_hourly WHERE ${HOUR_RANGE} GROUP BY project, model, hour`;
const PROJECT_SESSIONS_SQL = `SELECT project, COUNT(DISTINCT session_id) AS n FROM usage_hourly WHERE ${HOUR_RANGE} GROUP BY project`;

interface ProjectHourRow extends SumRow {
  project: string;
  model: string;
  hour: number;
}

export async function buildProjects(env: Env, from: UnixSeconds, to: UnixSeconds, tz: string): Promise<ProjectsResponse> {
  const db = env.DB;
  const [hoursRes, sessRes, metaRes] = await db.batch([
    db.prepare(PROJECT_HOURS_SQL).bind(from, to),
    db.prepare(PROJECT_SESSIONS_SQL).bind(from, to),
    db.prepare('SELECT project, label, path FROM projects'),
  ]);
  const days = new DayIndex(from, to, tz);
  const meta = new Map<string, { label: string; path: string | null }>();
  for (const m of (metaRes!.results ?? []) as { project: string; label: string; path: string | null }[]) meta.set(m.project, m);
  const sessions = new Map<string, number>();
  for (const s of (sessRes!.results ?? []) as { project: string; n: number }[]) sessions.set(s.project, s.n);

  interface Acc {
    totals: UsageTotals;
    modelCost: Map<string, number>;
    daily: number[];
    lastHour: number;
  }
  const acc = new Map<string, Acc>();
  for (const r of (hoursRes!.results ?? []) as ProjectHourRow[]) {
    let a = acc.get(r.project);
    if (!a) acc.set(r.project, (a = { totals: emptyTotals(), modelCost: new Map(), daily: new Array<number>(days.days.length).fill(0), lastHour: 0 }));
    addTotals(a.totals, r);
    a.modelCost.set(r.model, (a.modelCost.get(r.model) ?? 0) + r.costUsd + 1e-12 * (r.input + r.output));
    const i = days.indexOfHour(r.hour);
    if (i >= 0) a.daily[i]! += r.costUsd;
    a.lastHour = Math.max(a.lastHour, r.hour);
  }

  const projects: ProjectRow[] = [...acc.entries()].map(([project, a]) => {
    const m = meta.get(project);
    let topModel: string | null = null;
    let best = -1;
    for (const [model, c] of a.modelCost) {
      if (c > best) {
        best = c;
        topModel = model;
      }
    }
    return {
      ...a.totals,
      costUsd: round6(a.totals.costUsd),
      project,
      label: m?.label ?? project,
      path: m?.path ?? null,
      sessions: sessions.get(project) ?? 0,
      cacheHitRate: cacheHitRate(a.totals),
      topModel,
      // Hour precision: the end of the latest active hour, capped at the range end.
      lastActive: Math.min(a.lastHour + HOUR, to),
      sparkline: days.days.map((day, i) => ({ day, costUsd: round6(a.daily[i]!) })),
    };
  });
  projects.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return { from, to, projects };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const MODELS_SQL = `SELECT model, ${sumColumns()} FROM usage_hourly WHERE ${HOUR_RANGE} GROUP BY model`;

export async function buildModels(env: Env, from: UnixSeconds, to: UnixSeconds): Promise<ModelsResponse> {
  const rows = (await env.DB.prepare(MODELS_SQL).bind(from, to).all<SumRow & { model: string }>()).results ?? [];
  const totals = rows.map((r) => ({ model: r.model, t: totalsOf(r) }));
  const allCost = totals.reduce((a, x) => a + x.t.costUsd, 0);
  const allTokens = totals.reduce((a, x) => a + x.t.totalTokens, 0);
  const models: ModelRow[] = totals.map(({ model, t }) => {
    const norm = normalizeModel(model);
    return {
      ...t,
      costUsd: round6(t.costUsd),
      model,
      family: norm.family,
      priced: norm.priced,
      cacheHitRate: cacheHitRate(t),
      cacheSavingsUsd: round6(cacheSavings(t, model)),
      costShare: share(t.costUsd, allCost),
      tokenShare: share(t.totalTokens, allTokens),
    };
  });
  models.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return { from, to, models };
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

const HEATMAP_SQL = `SELECT hour, TOTAL(cost_usd) AS costUsd,
  TOTAL(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens, TOTAL(requests) AS requests
FROM usage_hourly WHERE hour >= ?1 AND hour <= ?2 GROUP BY hour`;
const LEGACY_SQL = 'SELECT day, TOTAL(tokens) AS tokens, TOTAL(requests) AS requests FROM daily_legacy WHERE day >= ?1 AND day <= ?2 GROUP BY day';

export async function buildHeatmap(env: Env, weeks: number, tz: string, now: UnixSeconds): Promise<HeatmapResponse> {
  const from = localDayStartBack(now, weeks * 7 - 1, tz);
  const days = new DayIndex(from, now, tz);
  const db = env.DB;
  const [hourRes, legacyRes] = await db.batch([
    db.prepare(HEATMAP_SQL).bind(from - HOUR_MID, now),
    db.prepare(LEGACY_SQL).bind(days.days[0]!, days.days[days.days.length - 1]!),
  ]);

  const calendar: CalendarDay[] = days.days.map((day) => ({ day, costUsd: 0, tokens: 0, requests: 0 }));
  const cells = new Map<number, HeatmapCell>();
  for (const r of (hourRes!.results ?? []) as { hour: number; costUsd: number; tokens: number; requests: number }[]) {
    const i = days.indexOfHour(r.hour);
    if (i < 0) continue;
    const c = calendar[i]!;
    c.costUsd += r.costUsd;
    c.tokens += r.tokens;
    c.requests += r.requests;
    const dow = days.dow(i);
    const hour = days.localHour(r.hour + HOUR_MID, i);
    const key = dow * 24 + hour;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { dow, hour, costUsd: 0, tokens: 0, requests: 0 }));
    cell.costUsd += r.costUsd;
    cell.tokens += r.tokens;
    cell.requests += r.requests;
  }
  // Pre-v2 daily totals fill days that have no hourly data (they carry no cost).
  const dayPos = new Map(days.days.map((d, i) => [d, i]));
  for (const r of (legacyRes!.results ?? []) as { day: string; tokens: number; requests: number }[]) {
    const c = calendar[dayPos.get(r.day) ?? -1];
    if (c && c.tokens === 0 && c.requests === 0) {
      c.tokens = r.tokens;
      c.requests = r.requests;
    }
  }
  for (const c of calendar) c.costUsd = round6(c.costUsd);
  const grid = [...cells.values()]
    .map((c) => ({ ...c, costUsd: round6(c.costUsd) }))
    .sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  return { from, to: now, weeks, tz, grid, calendar };
}
