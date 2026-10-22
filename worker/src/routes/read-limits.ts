// Plan-limit reads: latest status per window, history, hits and 5-hour block reconstruction.
import {
  DAY,
  FIVE_HOUR_SECONDS,
  limitWindowKey,
  projectWindow,
  windowSeconds,
  type FiveHourBlock,
  type LimitHistorySeries,
  type LimitHit,
  type LimitWindowStatus,
  type UnixSeconds,
} from '@ccu/shared';
import { windowLabel } from '../alerts.js';
import { HOUR_MID } from './read-days.js';
import { round6 } from './read-agg.js';

/** Distinct window keys via a skip-scan over the (window_key, ts) primary key: O(windows) rows. */
const KEYS_CTE = `WITH RECURSIVE k(key) AS (
  SELECT MIN(window_key) FROM limit_snapshots
  UNION ALL
  SELECT (SELECT MIN(window_key) FROM limit_snapshots WHERE window_key > k.key) FROM k WHERE k.key IS NOT NULL
)`;

export const LATEST_SNAPSHOTS_SQL = `${KEYS_CTE}
SELECT s.window_key AS key, s.ts AS ts, s.utilization AS utilization, s.resets_at AS resetsAt, s.severity AS severity
FROM k JOIN limit_snapshots AS s
  ON s.window_key = k.key AND s.ts = (SELECT MAX(ts) FROM limit_snapshots WHERE window_key = k.key)`;

/** Every snapshot with ts in [?1, ?2], one PK range scan per window. */
export const SNAPSHOT_RANGE_SQL = `${KEYS_CTE}
SELECT s.window_key AS key, s.ts AS ts, s.utilization AS utilization, s.resets_at AS resetsAt, s.severity AS severity
FROM k JOIN limit_snapshots AS s ON s.window_key = k.key AND s.ts >= ?1 AND s.ts <= ?2
ORDER BY s.window_key, s.ts`;

export const HITS_RANGE_SQL = 'SELECT ts, kind, resets_at AS resetsAt FROM limit_hits WHERE ts >= ?1 AND ts <= ?2 ORDER BY ts';

export interface SnapshotRow {
  key: string;
  ts: number;
  utilization: number;
  resetsAt: number;
  severity: string | null;
}

/** Windows whose latest snapshot is older than this are dropped (e.g. retired per-model keys). */
export const STALE_WINDOW_SECONDS = 7 * DAY;

const WINDOW_ORDER = (key: string): number => (key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : 2);

export function sortWindowKeys(a: string, b: string): number {
  return WINDOW_ORDER(a) - WINDOW_ORDER(b) || a.localeCompare(b);
}

/** Latest status with pace and projection. A window past its reset reports 0% with no projection. */
export function windowStatus(row: SnapshotRow, now: UnixSeconds): LimitWindowStatus {
  const length = windowSeconds(row.key);
  const base = {
    key: row.key,
    label: windowLabel(row.key),
    resetsAt: row.resetsAt,
    severity: row.severity ?? null,
    snapshotTs: row.ts,
    windowSeconds: length,
  };
  if (row.resetsAt <= now) {
    return { ...base, utilization: 0, elapsedFraction: 1, pace: null, projectedFullAt: null, projectedAtReset: null };
  }
  const p = projectWindow(row.utilization, row.resetsAt, length, now);
  return {
    ...base,
    utilization: row.utilization,
    elapsedFraction: p.elapsedFraction,
    pace: p.pace,
    projectedFullAt: p.projectedFullAt,
    projectedAtReset: p.projectedAtReset,
  };
}

export function currentLimits(rows: SnapshotRow[], now: UnixSeconds): LimitWindowStatus[] {
  return rows
    .filter((r) => r.ts >= now - STALE_WINDOW_SECONDS)
    .map((r) => windowStatus(r, now))
    .sort((a, b) => sortWindowKeys(a.key, b.key));
}

export function historySeries(rows: SnapshotRow[], from: UnixSeconds, to: UnixSeconds): LimitHistorySeries[] {
  const byKey = new Map<string, LimitHistorySeries>();
  for (const r of rows) {
    if (r.ts < from || r.ts > to) continue;
    let s = byKey.get(r.key);
    if (!s) byKey.set(r.key, (s = { key: r.key, label: windowLabel(r.key), points: [] }));
    s.points.push({ ts: r.ts, utilization: r.utilization, resetsAt: r.resetsAt, severity: r.severity ?? null });
  }
  return [...byKey.values()].sort((a, b) => sortWindowKeys(a.key, b.key));
}

export function hitsOf(rows: { ts: number; kind: string; resetsAt: number | null }[]): LimitHit[] {
  return rows.map((r) => ({ ts: r.ts, kind: limitWindowKey(r.kind), resetsAt: r.resetsAt ?? null }));
}

/** resets_at values within this distance belong to the same block (API jitter, minute rounding). */
export const BLOCK_RESET_TOLERANCE = 120;

interface BlockDraft {
  end: number;
  latestTs: number;
  peak: number;
}

/** Groups five_hour snapshots into blocks keyed by their reset time. */
export function blockDrafts(fiveHour: SnapshotRow[]): BlockDraft[] {
  const sorted = [...fiveHour].sort((a, b) => a.resetsAt - b.resetsAt || a.ts - b.ts);
  const out: BlockDraft[] = [];
  let cur: (BlockDraft & { lastReset: number }) | null = null;
  for (const s of sorted) {
    // A snapshot taken after its own reset describes no live block.
    if (s.ts >= s.resetsAt) continue;
    if (cur && s.resetsAt - cur.lastReset <= BLOCK_RESET_TOLERANCE) {
      cur.peak = Math.max(cur.peak, s.utilization);
      cur.lastReset = s.resetsAt;
      if (s.ts >= cur.latestTs) {
        cur.latestTs = s.ts;
        cur.end = s.resetsAt;
      }
      continue;
    }
    cur = { end: s.resetsAt, latestTs: s.ts, peak: s.utilization, lastReset: s.resetsAt };
    out.push(cur);
  }
  return out.map(({ end, latestTs, peak }) => ({ end, latestTs, peak }));
}

export interface HourUsage {
  hour: number;
  costUsd: number;
  tokens: number;
  requests: number;
}

/**
 * Attaches hourly usage to blocks (an hour belongs to the block containing its midpoint)
 * and keeps blocks overlapping [from, to]. Oldest first.
 */
export function buildBlocks(drafts: BlockDraft[], hours: HourUsage[], from: UnixSeconds, to: UnixSeconds, now: UnixSeconds): FiveHourBlock[] {
  const blocks: FiveHourBlock[] = drafts
    .map((d) => ({
      start: d.end - FIVE_HOUR_SECONDS,
      end: d.end,
      peakUtilization: d.peak,
      costUsd: 0,
      tokens: 0,
      requests: 0,
      costPerPercent: null as number | null,
      active: now >= d.end - FIVE_HOUR_SECONDS && now < d.end,
    }))
    .filter((b) => b.end > from && b.start <= to)
    .sort((a, b) => a.start - b.start);
  for (const h of hours) {
    const mid = h.hour + HOUR_MID;
    const b = blocks.find((x) => mid >= x.start && mid < x.end);
    if (!b) continue;
    b.costUsd += h.costUsd;
    b.tokens += h.tokens;
    b.requests += h.requests;
  }
  for (const b of blocks) {
    b.costUsd = round6(b.costUsd);
    b.costPerPercent = b.peakUtilization > 0 ? round6(b.costUsd / b.peakUtilization) : null;
  }
  return blocks;
}
