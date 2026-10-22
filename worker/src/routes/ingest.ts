import { validateDailyLegacyIngest, validateLimitsIngest, validateUsageIngest, type IngestResponse } from '@ccu/shared';
import { evaluateAfterLimits } from '../alerts.js';
import { META_SYNC_STATS, setMetaStatement, type SyncStatsMeta } from '../db.js';
import { HttpError, json, readJson, type RouteHandler } from '../http.js';
import { prepare, type BuiltStatement } from '../sql.js';
import {
  bucketStatements,
  dailyLegacyStatements,
  limitHitStatements,
  projectStatements,
  sessionStatements,
  snapshotRows,
  snapshotStatements,
  supersededUnknownHitsStatement,
} from '../upserts.js';

export const INGEST_MAX_BYTES = 1024 * 1024;

/** D1 allows 50 queries per invocation; leave headroom for bookkeeping. */
export const INGEST_STATEMENT_BUDGET = 45;
/** The limits route also runs alert evaluation in the same invocation. */
export const LIMITS_STATEMENT_BUDGET = 30;

function checkBudget(built: readonly BuiltStatement[], budget: number): void {
  if (built.length > budget) {
    throw new HttpError(413, `payload needs ${built.length} statements (max ${budget}); send smaller chunks (e.g. at most 500 rows per request)`);
  }
}

function validated<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new HttpError(400, r.error);
  return r.value;
}

export const ingestUsage: RouteHandler = async ({ req, env, now }) => {
  const body = validated(validateUsageIngest(await readJson(req, INGEST_MAX_BYTES)));
  const sessions = body.sessions ?? [];
  const projects = body.projects ?? [];
  const hits = body.limitHits ?? [];
  const built = [
    ...bucketStatements(body.buckets, body.device),
    ...sessionStatements(sessions, body.device),
    ...projectStatements(projects),
    ...limitHitStatements(hits),
  ];
  // Typed hits supersede OTLP's 'unknown' rows for the same 429.
  const superseded = supersededUnknownHitsStatement(hits.filter((h) => h.kind !== 'unknown'));
  if (superseded) built.push(superseded);
  const extra = body.stats ? 2 : 1;
  checkBudget(built, INGEST_STATEMENT_BUDGET - extra);

  const rowCount = body.buckets.length + sessions.length + projects.length + hits.length;
  const errors = body.stats?.errors?.length ? JSON.stringify(body.stats.errors) : null;
  const stmts = prepare(env.DB, built);
  stmts.push(
    env.DB.prepare(
      `INSERT INTO sync_runs (ts, device, rows, pending, version, errors) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(ts) DO UPDATE SET device=excluded.device, rows=COALESCE(sync_runs.rows, 0)+excluded.rows,
         pending=excluded.pending, version=excluded.version, errors=COALESCE(excluded.errors, sync_runs.errors)`,
    ).bind(now, body.device, rowCount, body.pending ?? 0, body.version, errors),
  );
  if (body.stats) {
    const meta: SyncStatsMeta = {
      ts: now,
      outputIncomplete: body.stats.outputIncomplete ?? 0,
      unpricedModels: body.stats.unpricedModels ?? [],
    };
    stmts.push(setMetaStatement(env.DB, META_SYNC_STATS, meta));
  }
  await env.DB.batch(stmts);

  const res: IngestResponse = {
    ok: true,
    accepted: { buckets: body.buckets.length, sessions: sessions.length, projects: projects.length, limitHits: hits.length },
  };
  return json(res);
};

export const ingestLimits: RouteHandler = async ({ req, env, ctx, now }) => {
  const body = validated(validateLimitsIngest(await readJson(req, INGEST_MAX_BYTES)));
  const rows = snapshotRows(body.snapshots);
  const built = snapshotStatements(rows);
  checkBudget(built, LIMITS_STATEMENT_BUDGET);
  if (built.length > 0) await env.DB.batch(prepare(env.DB, built));
  ctx.waitUntil(evaluateAfterLimits(env, now).catch((e: unknown) => console.error('alerts after limits failed', errText(e))));
  const res: IngestResponse = { ok: true, accepted: { snapshots: body.snapshots.length, windows: rows.length } };
  return json(res);
};

export const ingestDailyLegacy: RouteHandler = async ({ req, env }) => {
  const body = validated(validateDailyLegacyIngest(await readJson(req, INGEST_MAX_BYTES)));
  const built = dailyLegacyStatements(body.days);
  checkBudget(built, INGEST_STATEMENT_BUDGET);
  if (built.length > 0) await env.DB.batch(prepare(env.DB, built));
  const res: IngestResponse = { ok: true, accepted: { days: body.days.length } };
  return json(res);
};

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
