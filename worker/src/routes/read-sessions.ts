// Session list and detail. Session totals are whole-session (all hours), so cost and
// untracked overhead match the session's own cost-state.
import {
  emptyTotals,
  HOUR,
  type KeyedTotals,
  type SessionDetail,
  type SessionRow,
  type SessionSort,
  type SessionsResponse,
  type TimeseriesSeries,
  type UnixSeconds,
  type UsageTotals,
} from '@ccu/shared';
import type { Env } from '../db.js';
import { HttpError } from '../http.js';
import { addTotals, parseStringArray, round6, sumColumns, totalsOf, type SumRow } from './read-agg.js';

/** Sessions active in [?1, ?2], optionally one project (?3). Uses the sessions_last index. */
const CAND = `cand AS (SELECT session_id FROM sessions WHERE last_ts >= ?1 AND first_ts <= ?2 AND (?3 IS NULL OR project = ?3))`;

const META_COLUMNS = `s.session_id AS sessionId, s.project AS project, COALESCE(p.label, s.project) AS projectLabel,
  s.title AS title, s.git_branch AS gitBranch, s.models AS models, s.first_ts AS firstTs, s.last_ts AS lastTs,
  s.agent_count AS agentCount, s.cost_state_usd AS costStateUsd, s.lines_added AS linesAdded, s.lines_removed AS linesRemoved`;

const TOTAL_COLUMNS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'webSearch', 'requests', 'costUsd']
  .map((c) => `COALESCE(t.${c}, 0) AS ${c}`)
  .join(', ');

const COUNT_SQL = `WITH ${CAND} SELECT COUNT(*) AS n FROM cand`;

const BY_COST_SQL = `WITH ${CAND},
t AS (SELECT session_id, ${sumColumns()} FROM usage_hourly WHERE session_id IN (SELECT session_id FROM cand) GROUP BY session_id)
SELECT ${META_COLUMNS}, ${TOTAL_COLUMNS}
FROM cand JOIN sessions AS s ON s.session_id = cand.session_id
LEFT JOIN t ON t.session_id = s.session_id
LEFT JOIN projects AS p ON p.project = s.project
ORDER BY COALESCE(t.costUsd, 0) DESC, s.last_ts DESC, s.session_id
LIMIT ?4 OFFSET ?5`;

const BY_RECENT_SQL = `WITH page AS (
  SELECT * FROM sessions WHERE last_ts >= ?1 AND first_ts <= ?2 AND (?3 IS NULL OR project = ?3)
  ORDER BY last_ts DESC, session_id LIMIT ?4 OFFSET ?5
),
t AS (SELECT session_id, ${sumColumns()} FROM usage_hourly WHERE session_id IN (SELECT session_id FROM page) GROUP BY session_id)
SELECT ${META_COLUMNS.replace(/\bs\./g, 's.')}, ${TOTAL_COLUMNS}
FROM page AS s
LEFT JOIN t ON t.session_id = s.session_id
LEFT JOIN projects AS p ON p.project = s.project
ORDER BY s.last_ts DESC, s.session_id`;

interface SessionDbRow extends SumRow {
  sessionId: string;
  project: string;
  projectLabel: string;
  title: string | null;
  gitBranch: string | null;
  models: string | null;
  firstTs: number;
  lastTs: number;
  agentCount: number | null;
  costStateUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

/**
 * Sync uploads a session's row (with its cost-state) before all of its buckets, so
 * while the latest run still reports a backlog the overhead (cost-state minus the
 * uploaded buckets) would be inflated. One indexed row on sync_runs' rowid.
 */
const BACKLOG_SQL = 'SELECT pending FROM sync_runs ORDER BY ts DESC LIMIT 1';

function hasBacklog(res: D1Result | undefined): boolean {
  return (((res?.results ?? [])[0] as { pending: number | null } | undefined)?.pending ?? 0) > 0;
}

/** `uploading`: buckets are still pending upload, so the overhead is unknown (null). */
export function sessionRow(r: SessionDbRow, uploading = false): SessionRow {
  const t = totalsOf(r);
  const costUsd = round6(t.costUsd);
  return {
    ...t,
    costUsd,
    sessionId: r.sessionId,
    project: r.project,
    projectLabel: r.projectLabel ?? r.project,
    title: r.title ?? null,
    gitBranch: r.gitBranch ?? null,
    models: parseStringArray(r.models),
    firstTs: r.firstTs,
    lastTs: r.lastTs,
    durationSeconds: Math.max(0, r.lastTs - r.firstTs),
    agentCount: r.agentCount ?? 0,
    costStateUsd: r.costStateUsd ?? null,
    untrackedOverheadUsd: r.costStateUsd == null || uploading ? null : round6(r.costStateUsd - costUsd),
    linesAdded: r.linesAdded ?? null,
    linesRemoved: r.linesRemoved ?? null,
  };
}

export interface SessionsQuery {
  from: UnixSeconds;
  to: UnixSeconds;
  project: string | null;
  sort: SessionSort;
  limit: number;
  offset: number;
}

export async function buildSessions(env: Env, q: SessionsQuery): Promise<SessionsResponse> {
  const db = env.DB;
  const sql = q.sort === 'cost' ? BY_COST_SQL : BY_RECENT_SQL;
  const [countRes, pageRes, backlogRes] = await db.batch([
    db.prepare(COUNT_SQL).bind(q.from, q.to, q.project),
    db.prepare(sql).bind(q.from, q.to, q.project, q.limit, q.offset),
    db.prepare(BACKLOG_SQL),
  ]);
  const uploading = hasBacklog(backlogRes);
  const total = ((countRes!.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  return {
    from: q.from,
    to: q.to,
    total,
    limit: q.limit,
    offset: q.offset,
    sort: q.sort,
    sessions: ((pageRes!.results ?? []) as SessionDbRow[]).map((r) => sessionRow(r, uploading)),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const DETAIL_META_SQL = `SELECT ${META_COLUMNS} FROM sessions AS s LEFT JOIN projects AS p ON p.project = s.project WHERE s.session_id = ?1`;
const DETAIL_USAGE_SQL = `SELECT hour, model, agent_kind AS agentKind, project, ${sumColumns()}
FROM usage_hourly WHERE session_id = ?1 GROUP BY hour, model, agent_kind, project`;

interface DetailUsageRow extends SumRow {
  hour: number;
  model: string;
  agentKind: string;
  project: string;
}

function hourlySeries(rows: DetailUsageRow[], keyOf: (r: DetailUsageRow) => string, first: number, count: number): TimeseriesSeries[] {
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const k = keyOf(r);
    let arr = byKey.get(k);
    if (!arr) byKey.set(k, (arr = new Array<number>(count).fill(0)));
    arr[(r.hour - first) / HOUR]! += r.costUsd;
  }
  return [...byKey.entries()]
    .map(([key, arr]) => ({ key, arr, total: arr.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
    .map(({ key, arr }) => ({ key, points: arr.map((v, i): [number, number] => [first + i * HOUR, round6(v)]) }));
}

function keyedTotals(rows: DetailUsageRow[], keyOf: (r: DetailUsageRow) => string): KeyedTotals[] {
  const byKey = new Map<string, KeyedTotals>();
  for (const r of rows) {
    const k = keyOf(r);
    let t = byKey.get(k);
    if (!t) byKey.set(k, (t = { ...emptyTotals(), key: k }));
    addTotals(t, r);
  }
  return [...byKey.values()].map((t) => ({ ...t, costUsd: round6(t.costUsd) })).sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}

export async function buildSessionDetail(env: Env, sessionId: string): Promise<SessionDetail> {
  const db = env.DB;
  const [metaRes, usageRes, backlogRes] = await db.batch([
    db.prepare(DETAIL_META_SQL).bind(sessionId),
    db.prepare(DETAIL_USAGE_SQL).bind(sessionId),
    db.prepare(BACKLOG_SQL),
  ]);
  const meta = ((metaRes!.results ?? [])[0] as SessionDbRow | undefined) ?? null;
  const rows = (usageRes!.results ?? []) as DetailUsageRow[];
  if (!meta && rows.length === 0) throw new HttpError(404, 'session not found');

  const all: UsageTotals = emptyTotals();
  for (const r of rows) addTotals(all, r);
  all.costUsd = round6(all.costUsd);

  let firstHour = 0;
  let lastHour = 0;
  if (rows.length) {
    firstHour = Math.min(...rows.map((r) => r.hour));
    lastHour = Math.max(...rows.map((r) => r.hour));
  }
  const count = rows.length ? (lastHour - firstHour) / HOUR + 1 : 0;

  // Usage without a sessions row (meta not uploaded yet): synthesize one from the usage.
  const base: SessionDbRow = meta ?? {
    sessionId,
    project: rows[0]!.project,
    projectLabel: rows[0]!.project,
    title: null,
    gitBranch: null,
    models: JSON.stringify([...new Set(rows.map((r) => r.model))].sort()),
    firstTs: firstHour,
    lastTs: lastHour + HOUR,
    agentCount: 0,
    costStateUsd: null,
    linesAdded: null,
    linesRemoved: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearch: 0,
    requests: 0,
    costUsd: 0,
  };
  const session = sessionRow({ ...base, ...all }, hasBacklog(backlogRes));

  return {
    session,
    byModel: hourlySeries(rows, (r) => r.model, firstHour, count),
    byAgentKind: hourlySeries(rows, (r) => r.agentKind, firstHour, count),
    totals: {
      all,
      byModel: keyedTotals(rows, (r) => r.model),
      byAgentKind: keyedTotals(rows, (r) => r.agentKind),
    },
  };
}
