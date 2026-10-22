import { DAY, HOUR } from '@ccu/shared';
import type { Env } from './db.js';

export const LIVE_RETENTION = 72 * HOUR;
export const SNAPSHOT_RETENTION = 90 * DAY;
/** Snapshots newer than this keep full resolution. */
export const SNAPSHOT_FULL_RES = 7 * DAY;
/**
 * Thinning only scans snapshots that aged past 7 days recently. Pruning runs
 * hourly, so a 2-day lookback tolerates missed crons without rescanning 90 days.
 */
export const THIN_LOOKBACK = 2 * DAY;
/** sync_runs feed the ops page (last 20 runs, today's count) and the stale rule (latest run). */
export const SYNC_RUNS_RETENTION = 90 * DAY;
/** Any alert_state row this old is dropped (a still-stale sync then reminds once more). */
export const ALERT_STATE_RETENTION = 30 * DAY;
/**
 * Rows whose window reset this long ago can never match a rule again: threshold/pace rules
 * only see windows with resetsAt > now, budget keys are per day, and hits look back 2 hours.
 * `stale:` rows key on the last sync time instead of a reset, so they only age out by fired_at.
 */
export const ALERT_RESET_GRACE = DAY;

/**
 * Distinct window keys via a skip-scan over the (window_key, ts) primary key. Deletes
 * filter on `window_key IN k AND ts ...` so they seek on the PK instead of scanning the
 * table (limit_snapshots has no ts index on purpose: it would cost a write per snapshot).
 */
const WINDOW_KEYS_CTE = `WITH RECURSIVE k(key) AS (
  SELECT MIN(window_key) FROM limit_snapshots
  UNION ALL
  SELECT (SELECT MIN(window_key) FROM limit_snapshots WHERE window_key > k.key) FROM k WHERE k.key IS NOT NULL
)`;
const IN_WINDOWS = 'window_key IN (SELECT key FROM k WHERE key IS NOT NULL)';

/** Pruning runs once an hour: on the cron ticks in the first 5 minutes (UTC). */
export function shouldPrune(nowSec: number): boolean {
  return Math.floor(nowSec / 60) % 60 < 5;
}

export interface PruneResult {
  liveRequests: number;
  snapshotsExpired: number;
  snapshotsThinned: number;
  syncRuns: number;
  alertState: number;
}

export const PRUNE_SQL = {
  live: 'DELETE FROM live_requests WHERE ts < ?1',
  snapshotsExpired: `${WINDOW_KEYS_CTE} DELETE FROM limit_snapshots WHERE ${IN_WINDOWS} AND ts < ?1`,
  /** Keeps the earliest snapshot per window per UTC hour within [?1, ?2). */
  snapshotsThinned: `${WINDOW_KEYS_CTE} DELETE FROM limit_snapshots
    WHERE ${IN_WINDOWS} AND ts >= ?1 AND ts < ?2
      AND EXISTS (SELECT 1 FROM limit_snapshots AS o
                  WHERE o.window_key = limit_snapshots.window_key
                    AND o.ts < limit_snapshots.ts
                    AND o.ts >= (limit_snapshots.ts / 3600) * 3600)`,
  syncRuns: 'DELETE FROM sync_runs WHERE ts < ?1',
  /** alert_state is tiny (a few rows per window reset), so a scan is fine here. */
  alertState: `DELETE FROM alert_state WHERE fired_at < ?1
    OR (window_reset IS NOT NULL AND window_reset < ?2 AND substr(alert_key, 1, 6) <> 'stale:')`,
} as const;

export async function prune(env: Pick<Env, 'DB'>, nowSec: number): Promise<PruneResult> {
  const thinTo = nowSec - SNAPSHOT_FULL_RES;
  const [live, expired, thinned, syncRuns, alertState] = await env.DB.batch([
    env.DB.prepare(PRUNE_SQL.live).bind(nowSec - LIVE_RETENTION),
    env.DB.prepare(PRUNE_SQL.snapshotsExpired).bind(nowSec - SNAPSHOT_RETENTION),
    env.DB.prepare(PRUNE_SQL.snapshotsThinned).bind(thinTo - THIN_LOOKBACK, thinTo),
    env.DB.prepare(PRUNE_SQL.syncRuns).bind(nowSec - SYNC_RUNS_RETENTION),
    env.DB.prepare(PRUNE_SQL.alertState).bind(nowSec - ALERT_STATE_RETENTION, nowSec - ALERT_RESET_GRACE),
  ]);
  return {
    liveRequests: live?.meta.changes ?? 0,
    snapshotsExpired: expired?.meta.changes ?? 0,
    snapshotsThinned: thinned?.meta.changes ?? 0,
    syncRuns: syncRuns?.meta.changes ?? 0,
    alertState: alertState?.meta.changes ?? 0,
  };
}
