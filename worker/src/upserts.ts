// SQL for every ingest write path, as pure functions (statements are built here,
// executed by the routes). Each returns the minimal set of multi-row statements.
import {
  isoToUnix,
  roundToMinute,
  type DailyLegacyRow,
  type HourlyBucket,
  type LimitHit,
  type LimitSnapshot,
  type LiveRequest,
  type ProjectMeta,
  type SessionMeta,
} from '@ccu/shared';
import { buildInserts, upsertClause, type BuiltStatement, type SqlValue } from './sql.js';

const BUCKET_COLS = [
  'hour', 'project', 'model', 'agent_kind', 'session_id', 'requests', 'input', 'output',
  'cache_read', 'cache_write_5m', 'cache_write_1h', 'web_search', 'cost_usd', 'device',
] as const;
const BUCKET_KEY = ['hour', 'project', 'model', 'agent_kind', 'session_id'];

export function bucketStatements(buckets: readonly HourlyBucket[], device: string): BuiltStatement[] {
  const rows: SqlValue[][] = buckets.map((b) => [
    b.hour, b.project, b.model, b.agentKind, b.sessionId, b.requests, b.input, b.output,
    b.cacheRead, b.cacheWrite5m, b.cacheWrite1h, b.webSearch, b.costUsd, device,
  ]);
  return buildInserts(
    {
      table: 'usage_hourly',
      columns: BUCKET_COLS,
      suffix: upsertClause(BUCKET_KEY, BUCKET_COLS.filter((c) => !BUCKET_KEY.includes(c))),
    },
    rows,
  );
}

const SESSION_COLS = [
  'session_id', 'project', 'title', 'git_branch', 'first_ts', 'last_ts', 'models',
  'agent_count', 'cost_state_usd', 'lines_added', 'lines_removed', 'device',
] as const;

export function sessionStatements(sessions: readonly SessionMeta[], device: string): BuiltStatement[] {
  const rows: SqlValue[][] = sessions.map((s) => [
    s.sessionId, s.project, s.title ?? null, s.gitBranch ?? null, s.firstTs, s.lastTs, JSON.stringify(s.models),
    s.agentCount, s.costStateUsd ?? null, s.linesAdded ?? null, s.linesRemoved ?? null, device,
  ]);
  const keep = (c: string) => `COALESCE(excluded.${c}, sessions.${c})`;
  return buildInserts(
    {
      table: 'sessions',
      columns: SESSION_COLS,
      suffix: upsertClause(['session_id'], SESSION_COLS.slice(1), {
        title: keep('title'),
        git_branch: keep('git_branch'),
        first_ts: 'MIN(sessions.first_ts, excluded.first_ts)',
        last_ts: 'MAX(sessions.last_ts, excluded.last_ts)',
        cost_state_usd: keep('cost_state_usd'),
        lines_added: keep('lines_added'),
        lines_removed: keep('lines_removed'),
      }),
    },
    rows,
  );
}

export function projectStatements(projects: readonly ProjectMeta[]): BuiltStatement[] {
  return buildInserts(
    {
      table: 'projects',
      columns: ['project', 'label', 'path'],
      suffix: upsertClause(['project'], ['label', 'path'], { path: 'COALESCE(excluded.path, projects.path)' }),
    },
    projects.map((p) => [p.project, p.label, p.path ?? null]),
  );
}

export function limitHitStatements(hits: readonly LimitHit[], verb: 'upsert' | 'ignore' = 'upsert'): BuiltStatement[] {
  return buildInserts(
    verb === 'ignore'
      ? { table: 'limit_hits', columns: ['ts', 'kind', 'resets_at'], verb: 'INSERT OR IGNORE' }
      : {
          table: 'limit_hits',
          columns: ['ts', 'kind', 'resets_at'],
          suffix: upsertClause(['ts', 'kind'], ['resets_at'], { resets_at: 'COALESCE(excluded.resets_at, limit_hits.resets_at)' }),
        },
    hits.map((h) => [h.ts, h.kind, h.resetsAt ?? null]),
  );
}

/** An OTLP `unknown` hit and a typed transcript hit this close together are the same event. */
export const HIT_MATCH_WINDOW = 5 * 60;

export const SUPERSEDED_UNKNOWN_HITS_SQL =
  `DELETE FROM limit_hits WHERE kind = 'unknown' AND ts >= ?1 AND ts <= ?2 AND EXISTS (` +
  `SELECT 1 FROM limit_hits AS t WHERE t.ts >= limit_hits.ts - ${HIT_MATCH_WINDOW} AND t.ts <= limit_hits.ts + ${HIT_MATCH_WINDOW} AND t.kind <> 'unknown')`;

/**
 * Deletes `unknown` hits that a typed hit within HIT_MATCH_WINDOW supersedes, scoped
 * to the time range these hits could affect. Run after inserting the hits, from
 * either side (sync's typed hits or OTLP's unknown ones), so arrival order is moot.
 */
export function supersededUnknownHitsStatement(hits: readonly LimitHit[]): BuiltStatement | null {
  if (hits.length === 0) return null;
  const ts = hits.map((h) => h.ts);
  return {
    sql: SUPERSEDED_UNKNOWN_HITS_SQL,
    params: [String(Math.min(...ts) - HIT_MATCH_WINDOW), String(Math.max(...ts) + HIT_MATCH_WINDOW)],
    rows: 0,
  };
}

/** One limit_snapshots row per window; resetsAt is stored rounded to the minute. */
export function snapshotRows(snapshots: readonly LimitSnapshot[]): SqlValue[][] {
  const rows: SqlValue[][] = [];
  for (const s of snapshots) {
    for (const w of s.windows) {
      const resets = isoToUnix(w.resetsAt);
      if (resets === null) continue;
      rows.push([s.ts, w.key, w.utilization, roundToMinute(resets), w.severity ?? null]);
    }
  }
  return rows;
}

export function snapshotStatements(rows: readonly SqlValue[][]): BuiltStatement[] {
  return buildInserts(
    {
      table: 'limit_snapshots',
      columns: ['ts', 'window_key', 'utilization', 'resets_at', 'severity'],
      suffix: upsertClause(['window_key', 'ts'], ['utilization', 'resets_at', 'severity']),
    },
    rows,
  );
}

export function dailyLegacyStatements(days: readonly DailyLegacyRow[]): BuiltStatement[] {
  return buildInserts(
    {
      table: 'daily_legacy',
      columns: ['day', 'model', 'tokens', 'requests'],
      suffix: upsertClause(['day', 'model'], ['tokens', 'requests']),
    },
    days.map((d) => [d.day, d.model, d.tokens, d.requests]),
  );
}

const LIVE_COLS = [
  'request_id', 'ts', 'session_id', 'model', 'input', 'output', 'cache_read', 'cache_write_5m',
  'cache_write_1h', 'cost_usd', 'duration_ms', 'ttft_ms', 'speed', 'effort', 'query_source',
] as const;

export function liveRequestStatements(requests: readonly LiveRequest[]): BuiltStatement[] {
  return buildInserts(
    { table: 'live_requests', columns: LIVE_COLS, verb: 'INSERT OR IGNORE' },
    requests.map((r) => [
      r.requestId, r.ts, r.sessionId, r.model, r.input, r.output, r.cacheRead, r.cacheWrite5m,
      r.cacheWrite1h, r.costUsd, r.durationMs, r.ttftMs, r.speed, r.effort, r.querySource,
    ]),
  );
}
