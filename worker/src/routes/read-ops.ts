// Operational reads: live OTel requests and worker/sync status.
import { DAY, MINUTE, minuteStart, type LiveMinutePoint, type LiveRequest, type LiveResponse, type StatusResponse, type SyncRun, type UnixSeconds } from '@ccu/shared';
import { getMeta, META_SYNC_STATS, setMetaStatement, type Env, type SyncStatsMeta } from '../db.js';
import { API_VERSION } from '../version.js';
import { parseStringArray, round6, unpricedOf } from './read-agg.js';

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

const LIVE_TOKENS = 'COALESCE(input, 0) + COALESCE(output, 0) + COALESCE(cache_read, 0) + COALESCE(cache_write_5m, 0) + COALESCE(cache_write_1h, 0)';

const LIVE_MINUTES_SQL = `SELECT (ts / 60) * 60 AS t, COUNT(*) AS requests, TOTAL(cost_usd) AS costUsd, TOTAL(${LIVE_TOKENS}) AS tokens
FROM live_requests WHERE ts >= ?1 AND ts <= ?2 GROUP BY t`;

const LIVE_RECENT_SQL = `SELECT request_id AS requestId, ts, session_id AS sessionId, model, input, output, cache_read AS cacheRead,
  cache_write_5m AS cacheWrite5m, cache_write_1h AS cacheWrite1h, cost_usd AS costUsd, duration_ms AS durationMs, ttft_ms AS ttftMs,
  speed, effort, query_source AS querySource
FROM live_requests ORDER BY ts DESC, request_id LIMIT 50`;

export async function buildLive(env: Env, minutes: number, now: UnixSeconds): Promise<LiveResponse> {
  const first = minuteStart(now) - (minutes - 1) * MINUTE;
  const db = env.DB;
  const [minRes, recentRes] = await db.batch([db.prepare(LIVE_MINUTES_SQL).bind(first, now), db.prepare(LIVE_RECENT_SQL)]);
  const perMinute: LiveMinutePoint[] = Array.from({ length: minutes }, (_, i) => ({ t: first + i * MINUTE, requests: 0, costUsd: 0, tokens: 0 }));
  for (const r of (minRes!.results ?? []) as LiveMinutePoint[]) {
    const p = perMinute[(r.t - first) / MINUTE];
    if (!p) continue;
    p.requests = r.requests;
    p.costUsd = round6(r.costUsd);
    p.tokens = r.tokens;
  }
  const recent = (recentRes!.results ?? []) as LiveRequest[];
  return { minutes, perMinute, recent, lastReceivedTs: recent[0]?.ts ?? null };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const COUNTED_TABLES = [
  'usage_hourly',
  'sessions',
  'projects',
  'limit_snapshots',
  'limit_hits',
  'live_requests',
  'daily_legacy',
  'sync_runs',
  'alert_state',
  'settings',
] as const;

/** COUNT(*) reads every row, so counts are cached and refreshed at most this often. */
export const TABLE_ROWS_TTL = 6 * 3600;
const META_TABLE_ROWS = 'tableRows';

interface TableRowsMeta {
  ts: number;
  counts: Record<string, number>;
}

export const FREE_TIER = { rowsWrittenPerDay: 100_000, rowsReadPerDay: 5_000_000, requestsPerDay: 100_000 } as const;

const SYNC_RUNS_SQL = 'SELECT ts, device, rows, pending, version, errors FROM sync_runs ORDER BY ts DESC LIMIT 20';
const SYNC_TODAY_SQL = 'SELECT COUNT(*) AS runs, TOTAL(rows) AS rows FROM sync_runs WHERE ts >= ?1';
const LIVE_TODAY_SQL = 'SELECT COUNT(*) AS n, MAX(ts) AS lastTs FROM live_requests WHERE ts >= ?1';
const LIVE_LAST_SQL = 'SELECT MAX(ts) AS lastTs FROM live_requests';
const LIVE_MODELS_SQL = 'SELECT DISTINCT model FROM live_requests WHERE ts >= ?1 AND model IS NOT NULL';
const SNAPSHOTS_TODAY_SQL = `WITH RECURSIVE k(key) AS (
  SELECT MIN(window_key) FROM limit_snapshots
  UNION ALL
  SELECT (SELECT MIN(window_key) FROM limit_snapshots WHERE window_key > k.key) FROM k WHERE k.key IS NOT NULL
)
SELECT COUNT(*) AS n FROM k JOIN limit_snapshots AS s ON s.window_key = k.key AND s.ts >= ?1`;

/**
 * Rows written since UTC midnight, approximated from what the worker logs: each synced
 * row is an upsert touching the table and (for usage) its session index, plus the sync_runs
 * row; each live request writes its row and its ts index entry, plus the PK; snapshots one each.
 */
export function estimateRowsWritten(syncRuns: number, syncRows: number, liveRequests: number, snapshots: number): number {
  return Math.round(2 * syncRows + syncRuns + 3 * liveRequests + snapshots);
}

async function tableRows(env: Env, now: UnixSeconds): Promise<Record<string, number>> {
  const cached = await getMeta<TableRowsMeta>(env.DB, META_TABLE_ROWS);
  if (cached && typeof cached.ts === 'number' && now - cached.ts < TABLE_ROWS_TTL && cached.counts) return cached.counts;
  const res = await env.DB.batch(COUNTED_TABLES.map((t) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`)));
  const counts: Record<string, number> = {};
  COUNTED_TABLES.forEach((t, i) => {
    counts[t] = ((res[i]!.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  });
  await setMetaStatement(env.DB, META_TABLE_ROWS, { ts: now, counts } satisfies TableRowsMeta).run();
  return counts;
}

export async function buildStatus(env: Env, now: UnixSeconds): Promise<StatusResponse> {
  const db = env.DB;
  const utcMidnight = now - (now % DAY);
  const [runsRes, syncTodayRes, liveTodayRes, liveLastRes, liveModelsRes, snapRes] = await db.batch([
    db.prepare(SYNC_RUNS_SQL),
    db.prepare(SYNC_TODAY_SQL).bind(utcMidnight),
    db.prepare(LIVE_TODAY_SQL).bind(utcMidnight),
    db.prepare(LIVE_LAST_SQL),
    db.prepare(LIVE_MODELS_SQL).bind(now - DAY),
    db.prepare(SNAPSHOTS_TODAY_SQL).bind(utcMidnight),
  ]);
  const stats = await getMeta<Partial<SyncStatsMeta>>(db, META_SYNC_STATS);
  const counts = await tableRows(env, now);

  type RunRow = { ts: number; device: string | null; rows: number | null; pending: number | null; version: string | null; errors: string | null };
  const syncRuns: SyncRun[] = ((runsRes!.results ?? []) as RunRow[]).map((r) => ({
    ts: r.ts,
    device: r.device ?? null,
    rows: r.rows ?? null,
    pending: r.pending ?? null,
    version: r.version ?? null,
    errors: parseStringArray(r.errors),
  }));
  const syncToday = ((syncTodayRes!.results ?? [])[0] as { runs: number; rows: number } | undefined) ?? { runs: 0, rows: 0 };
  const liveToday = ((liveTodayRes!.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  const otelLast = ((liveLastRes!.results ?? [])[0] as { lastTs: number | null } | undefined)?.lastTs ?? null;
  const snapsToday = ((snapRes!.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  const liveModels = ((liveModelsRes!.results ?? []) as { model: string }[]).map((r) => r.model);
  const reported = Array.isArray(stats?.unpricedModels) ? stats.unpricedModels.filter((m): m is string => typeof m === 'string') : [];

  return {
    version: API_VERSION,
    syncRuns,
    tableRows: counts,
    unpricedModels: unpricedOf([...reported, ...liveModels]),
    otelLastReceivedTs: otelLast,
    outputIncomplete: {
      requests: typeof stats?.outputIncomplete === 'number' ? stats.outputIncomplete : 0,
      reportedTs: typeof stats?.ts === 'number' ? stats.ts : null,
    },
    d1RowsWrittenToday: estimateRowsWritten(syncToday.runs, syncToday.rows, liveToday, snapsToday),
    freeTier: { ...FREE_TIER },
  };
}
