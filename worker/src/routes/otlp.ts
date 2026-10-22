import { HttpError, json, readJson, type RouteHandler } from '../http.js';
import { parseOtlpLogs } from '../otlp.js';
import { prepare } from '../sql.js';
import { limitHitStatements, liveRequestStatements, supersededUnknownHitsStatement } from '../upserts.js';

export const OTLP_MAX_BYTES = 256 * 1024;
export const OTLP_STATEMENT_BUDGET = 45;

function requireJson(req: Request): void {
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('protobuf')) {
    throw new HttpError(415, 'only OTLP http/json is supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
  }
}

/**
 * POST /v1/logs. Answers fast: one parse, at most one D1 batch. Rows beyond the
 * statement budget are dropped and reported as rejected (a 5xx would make the
 * exporter retry the same oversized batch forever).
 */
export const otlpLogs: RouteHandler = async ({ req, env, now }) => {
  requireJson(req);
  const parsed = parseOtlpLogs(await readJson(req, OTLP_MAX_BYTES), now);

  const hitStmts = limitHitStatements(parsed.limitHits, 'ignore').slice(0, 5);
  // Drop the new 'unknown' rows again if sync already stored the typed hit.
  const superseded = hitStmts.length > 0 ? supersededUnknownHitsStatement(parsed.limitHits) : null;
  if (superseded) hitStmts.push(superseded);
  const liveBuilt = liveRequestStatements(parsed.requests);
  const liveStmts = liveBuilt.slice(0, OTLP_STATEMENT_BUDGET - hitStmts.length);
  const keptRows = liveStmts.reduce((n, s) => n + s.rows, 0);
  const rejected = parsed.invalid + (parsed.requests.length - keptRows);

  const stmts = prepare(env.DB, [...liveStmts, ...hitStmts]);
  if (stmts.length > 0) await env.DB.batch(stmts);

  if (rejected > 0) {
    return json({ partialSuccess: { rejectedLogRecords: String(rejected), errorMessage: 'some api_request records were malformed or over the per-request limit' } });
  }
  return json({ partialSuccess: {} });
};

/** POST /v1/metrics: metrics duplicate the logs, so they are acknowledged and dropped. */
export const otlpMetrics: RouteHandler = () => json({});
