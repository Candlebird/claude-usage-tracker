// GET /api/summary: period KPIs, burn rate, current limits and sync freshness.
import { HOUR, hourStartUtc, type BurnRate, type SummaryResponse, type SyncInfo, type UnixSeconds } from '@ccu/shared';
import { getSettings, type Env } from '../db.js';
import { ModelRollup, round6, sumColumns, unpricedOf, type SumRow } from './read-agg.js';
import { HOUR_MID, localDayStartBack } from './read-days.js';
import { currentLimits, LATEST_SNAPSHOTS_SQL, type SnapshotRow } from './read-limits.js';

export const BURN_WINDOW = HOUR;
/** Floor for the span a rate is divided by, so a just-finished sync cannot blow it up. */
export const MIN_BURN_SPAN = 5 * 60;

/** One scan of the last 30 local days; `p` = 0 today, 1 rest of 7d, 2 rest of 30d (by hour midpoint). */
const PERIODS_SQL = `SELECT model, session_id AS sessionId,
  CASE WHEN hour >= ?1 THEN 0 WHEN hour >= ?2 THEN 1 ELSE 2 END AS p, ${sumColumns()}
FROM usage_hourly WHERE hour >= ?3 AND hour <= ?4
GROUP BY model, session_id, p`;

/** Hourly buckets that can overlap the burn window. */
const BURN_HOURLY_SQL = `SELECT hour, TOTAL(cost_usd) AS costUsd,
  TOTAL(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens, TOTAL(requests) AS requests
FROM usage_hourly WHERE hour >= ?1 AND hour <= ?2 GROUP BY hour`;

const BURN_LIVE_SQL = `SELECT COUNT(*) AS requests, TOTAL(cost_usd) AS costUsd,
  TOTAL(COALESCE(input, 0) + COALESCE(output, 0) + COALESCE(cache_read, 0) + COALESCE(cache_write_5m, 0) + COALESCE(cache_write_1h, 0)) AS tokens
FROM live_requests WHERE ts >= ?1 AND ts <= ?2`;

const LAST_SYNC_SQL = 'SELECT ts, device, pending FROM sync_runs ORDER BY ts DESC LIMIT 1';

interface PeriodRow extends SumRow {
  model: string;
  sessionId: string;
  p: number;
}

interface BurnHourRow {
  hour: number;
  costUsd: number;
  tokens: number;
  requests: number;
}

interface BurnLiveRow {
  requests: number;
  costUsd: number;
  tokens: number;
}

interface SyncRow {
  ts: number;
  device: string | null;
  pending: number | null;
}

/**
 * Last 60 minutes. Hourly rollups are authoritative up to the last sync; each bucket is
 * prorated by how much of its synced span falls in the window. Live OTel rows fill only
 * the trailing part the sync has not covered yet. Without live rows nothing is known
 * about [lastSync, now], so the rate is taken over the covered span only (and
 * `windowMinutes` reports that span) instead of diluting it over the full hour.
 */
export function burnRate(hours: BurnHourRow[], live: BurnLiveRow | null, lastSyncTs: UnixSeconds | null, now: UnixSeconds): BurnRate {
  const windowStart = now - BURN_WINDOW;
  const cutoff = Math.min(now, Math.max(windowStart, lastSyncTs ?? windowStart));
  let cost = 0;
  let tokens = 0;
  let requests = 0;
  let usedHourly = false;
  for (const h of hours) {
    const spanEnd = Math.min(h.hour + HOUR, Math.max(h.hour + 1, lastSyncTs ?? h.hour + HOUR));
    const overlap = Math.min(spanEnd, cutoff) - Math.max(h.hour, windowStart);
    if (overlap <= 0) continue;
    const f = overlap / (spanEnd - h.hour);
    cost += h.costUsd * f;
    tokens += h.tokens * f;
    requests += h.requests * f;
    if (h.requests > 0) usedHourly = true;
  }
  const usedLive = !!live && live.requests > 0;
  if (live) {
    cost += live.costUsd;
    tokens += live.tokens;
    requests += live.requests;
  }
  const span = Math.max(MIN_BURN_SPAN, (usedLive ? now : cutoff) - windowStart);
  const minutes = span / 60;
  return {
    windowMinutes: Math.round(minutes),
    costPerHour: round6((cost * HOUR) / span),
    tokensPerMinute: Math.round((tokens / minutes) * 100) / 100,
    requests: Math.round(requests),
    source: usedHourly && usedLive ? 'merged' : usedLive ? 'live' : 'hourly',
  };
}

export function syncInfo(row: SyncRow | null, now: UnixSeconds): SyncInfo {
  if (!row) return { lastSyncTs: null, ageSeconds: null, pending: 0, device: null };
  return { lastSyncTs: row.ts, ageSeconds: Math.max(0, now - row.ts), pending: row.pending ?? 0, device: row.device ?? null };
}

export async function buildSummary(env: Env, tz: string, now: UnixSeconds): Promise<SummaryResponse> {
  const today = localDayStartBack(now, 0, tz);
  const d7 = localDayStartBack(now, 6, tz);
  const d30 = localDayStartBack(now, 29, tz);
  const db = env.DB;

  const [periodRes, snapRes, syncRes] = await db.batch([
    db.prepare(PERIODS_SQL).bind(today - HOUR_MID, d7 - HOUR_MID, d30 - HOUR_MID, now),
    db.prepare(LATEST_SNAPSHOTS_SQL),
    db.prepare(LAST_SYNC_SQL),
  ]);
  const sync = syncInfo(((syncRes!.results ?? [])[0] as SyncRow | undefined) ?? null, now);

  // Burn rate needs the sync cutoff, so it runs after the first batch.
  const windowStart = now - BURN_WINDOW;
  const cutoff = Math.min(now, Math.max(windowStart, sync.lastSyncTs ?? windowStart));
  const [hourRes, liveRes] = await db.batch([
    db.prepare(BURN_HOURLY_SQL).bind(hourStartUtc(windowStart), now),
    db.prepare(BURN_LIVE_SQL).bind(cutoff, now),
  ]);

  const periods = [new ModelRollup(), new ModelRollup(), new ModelRollup()];
  for (const r of (periodRes!.results ?? []) as PeriodRow[]) {
    // Today's rows count toward all three periods, the 7d rows toward 7d and 30d.
    for (let i = r.p; i < 3; i++) periods[i]!.add(r.model, r, r.sessionId);
  }
  const unpricedModels = unpricedOf(periods[2]!.byModel.keys());
  const settings = await getSettings(env);

  return {
    generatedAt: now,
    tz,
    today: periods[0]!.kpis(),
    last7d: periods[1]!.kpis(),
    last30d: periods[2]!.kpis(),
    burnRate: burnRate((hourRes!.results ?? []) as BurnHourRow[], ((liveRes!.results ?? [])[0] as BurnLiveRow | undefined) ?? null, sync.lastSyncTs, now),
    limits: currentLimits((snapRes!.results ?? []) as SnapshotRow[], now),
    sync,
    unpricedModels,
    hasUnpriced: unpricedModels.length > 0,
    dailyBudgetUsd: settings.dailyBudgetUsd,
  };
}
