import { DEFAULT_SETTINGS, limitWindowKey, SEVEN_DAY_SECONDS, type FiveHourBlock, type LimitHistoryPoint, type LimitHit, type LimitWindowStatus, type Settings } from '@ccu/shared';
import { assignColors } from '../../palette';

export type Thresholds = readonly [number, number];

export const isFiveHour = (key: string): boolean => key.startsWith('five_hour');
export const isWeekly = (key: string): boolean => key.startsWith('seven_day');

/** Alert thresholds that apply to a window (the user's settings, or the defaults). */
export function thresholdsFor(key: string, settings: Settings | undefined): Thresholds {
  const t = (settings ?? DEFAULT_SETTINGS).alertThresholds;
  const pair = isFiveHour(key) ? t.fiveHour : t.weekly;
  return [pair[0], pair[1]];
}

/** Five-hour first, then all-model weekly, then per-model weeklies alphabetically. */
export function orderWindowKeys(keys: readonly string[]): string[] {
  const rank = (k: string) => (isFiveHour(k) ? 0 : k === 'seven_day' ? 1 : 2);
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** One fixed color per window key, assigned over the stable ordered key list. */
export function windowColors(keys: readonly string[]): Map<string, string> {
  return assignColors(orderWindowKeys(keys));
}

/**
 * Window key for a limit-hit kind. Older data may carry the raw `rateLimitType`
 * (`seven_day_opus`) while snapshot windows use `seven_day:opus`; the shared
 * `limitWindowKey` is the single normalization rule.
 */
export function hitWindowKey(kind: string): string {
  return limitWindowKey(kind);
}

/** Hits that belong to window `key`. */
export function hitsForWindow<H extends LimitHit>(hits: readonly H[], key: string): H[] {
  return hits.filter((h) => hitWindowKey(h.kind) === key);
}

const KIND_LABELS: Record<string, string> = { five_hour: '5-hour session', seven_day: 'Weekly (all models)' };

/** Human label for a limit-hit kind; prefers the label of a matching current window. */
export function hitKindLabel(kind: string, windows: readonly { key: string; label: string }[] = []): string {
  const key = hitWindowKey(kind);
  const w = windows.find((x) => x.key === key);
  if (w) return w.label;
  if (KIND_LABELS[kind]) return KIND_LABELS[kind]!;
  if (kind.startsWith('seven_day')) {
    const model = kind.split(/[:_]/).slice(2).join(' ');
    return model ? `Weekly (${model.charAt(0).toUpperCase()}${model.slice(1)})` : 'Weekly';
  }
  return kind === 'unknown' ? 'Unknown limit' : kind;
}

/**
 * Times at which a window reset inside the observed points: whenever a point's
 * reset time has already passed by the next point. Idle five-hour points report a
 * rolling resetsAt in the future, so they never produce false markers.
 */
export function resetMarkers(points: readonly LimitHistoryPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (prev.resetsAt <= cur.ts && prev.resetsAt !== cur.resetsAt && prev.utilization > 0) {
      if (out[out.length - 1] !== prev.resetsAt) out.push(prev.resetsAt);
    }
  }
  return out;
}

export interface HistoryStats {
  peak: number | null;
  peakTs: number | null;
  latest: number | null;
  /** Share (0-1) of samples at or above the warning threshold. */
  shareAboveWarning: number | null;
  resets: number;
}

export function historyStats(points: readonly LimitHistoryPoint[], warning: number): HistoryStats {
  if (points.length === 0) return { peak: null, peakTs: null, latest: null, shareAboveWarning: null, resets: 0 };
  let peak = points[0]!;
  let above = 0;
  for (const p of points) {
    if (p.utilization > peak.utilization) peak = p;
    if (p.utilization >= warning) above++;
  }
  return {
    peak: peak.utilization,
    peakTs: peak.ts,
    latest: points[points.length - 1]!.utilization,
    shareAboveWarning: above / points.length,
    resets: resetMarkers(points).length,
  };
}

/** Blocks below this peak give a noisy cost-per-1% and are left out of the capacity estimate. */
export const MIN_PEAK_FOR_CAPACITY = 10;

export interface BlockSummary {
  count: number;
  completed: number;
  /** Blocks that reached 100%. */
  maxedOut: number;
  avgPeak: number | null;
  /** Median USD per 1% across blocks with a meaningful peak. */
  medianCostPerPercent: number | null;
  /** medianCostPerPercent * 100: the API-equivalent cost a full 5-hour block holds. */
  capacityUsd: number | null;
  sampleSize: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarizeBlocks(blocks: readonly FiveHourBlock[]): BlockSummary {
  const samples = blocks
    .filter((b) => b.costPerPercent != null && b.costPerPercent > 0 && b.peakUtilization >= MIN_PEAK_FOR_CAPACITY)
    .map((b) => b.costPerPercent!);
  const med = median(samples);
  return {
    count: blocks.length,
    completed: blocks.filter((b) => !b.active).length,
    maxedOut: blocks.filter((b) => b.peakUtilization >= 100).length,
    avgPeak: blocks.length ? blocks.reduce((n, b) => n + b.peakUtilization, 0) / blocks.length : null,
    medianCostPerPercent: med,
    capacityUsd: med == null ? null : med * 100,
    sampleSize: samples.length,
  };
}

// ---------------------------------------------------------------------------
// Weekly pace projection
// ---------------------------------------------------------------------------

export interface PaceRow {
  t: number;
  /** Observed utilization (only up to the latest snapshot). */
  actual?: number;
  /** Straight line 0 -> 100 across the window. */
  even: number;
  /** Linear projection from the latest snapshot to reset at the window's average rate. */
  projected?: number;
}

export interface PaceModel {
  key: string;
  label: string;
  start: number;
  resetsAt: number;
  utilization: number;
  pace: number | null;
  projectedAtReset: number | null;
  projectedFullAt: number | null;
  /** Percent per day still available to land exactly on 100% at reset. */
  allowancePerDay: number | null;
  /** Utilization gained over the last 24h of history (percentage points), if known. */
  last24h: number | null;
  /** True when the 24h rate would run out before reset. */
  recentRunsOut: boolean;
  rows: PaceRow[];
}

const DAY = 86_400;

/**
 * Builds the pace chart for one weekly window from its current status and its
 * history points (only the points inside the current window are used).
 */
export function buildPaceModel(w: LimitWindowStatus, history: readonly LimitHistoryPoint[], now: number): PaceModel {
  const len = w.windowSeconds || SEVEN_DAY_SECONDS;
  const start = w.resetsAt - len;
  const evenAt = (t: number) => Math.max(0, Math.min(100, ((t - start) / len) * 100));
  const inWindow = history.filter((p) => p.ts >= start && p.ts <= Math.min(now, w.resetsAt) && p.resetsAt === w.resetsAt);

  const rows: PaceRow[] = [{ t: start, actual: 0, even: 0 }];
  for (const p of inWindow) if (p.ts > start) rows.push({ t: p.ts, actual: p.utilization, even: evenAt(p.ts) });
  const at = Math.max(start, Math.min(now, w.resetsAt));
  const lastActual = rows[rows.length - 1]!;
  if (lastActual.t < at) rows.push({ t: at, actual: w.utilization, even: evenAt(at) });
  else lastActual.actual = w.utilization;

  const anchor = rows[rows.length - 1]!;
  if (w.projectedAtReset != null && anchor.t < w.resetsAt) {
    anchor.projected = w.utilization;
    rows.push({ t: w.resetsAt, even: 100, projected: w.projectedAtReset });
  } else if (anchor.t < w.resetsAt) {
    rows.push({ t: w.resetsAt, even: 100 });
  }

  const daysLeft = Math.max(0, w.resetsAt - now) / DAY;
  const allowancePerDay = daysLeft > 0 ? Math.max(0, 100 - w.utilization) / daysLeft : null;

  const dayAgo = now - DAY;
  const before = [...inWindow].reverse().find((p) => p.ts <= dayAgo);
  const last24h = before ? Math.max(0, w.utilization - before.utilization) : start >= dayAgo ? w.utilization : null;
  const recentRunsOut = last24h != null && daysLeft > 0 && w.utilization + last24h * daysLeft >= 100;

  return {
    key: w.key,
    label: w.label,
    start,
    resetsAt: w.resetsAt,
    utilization: w.utilization,
    pace: w.pace,
    projectedAtReset: w.projectedAtReset,
    projectedFullAt: w.projectedFullAt,
    allowancePerDay,
    last24h,
    recentRunsOut,
    rows,
  };
}

/** Plain-language pace verdict. */
export function paceVerdict(pace: number | null): { tone: 'ok' | 'ahead' | 'over'; text: string } {
  if (pace == null) return { tone: 'ok', text: 'Too early to tell' };
  if (pace > 1.15) return { tone: 'over', text: 'Running hot' };
  if (pace > 1.0) return { tone: 'ahead', text: 'Slightly ahead of pace' };
  return { tone: 'ok', text: 'Under pace' };
}

// ---------------------------------------------------------------------------
// Limit hits
// ---------------------------------------------------------------------------

export interface HitRow extends LimitHit {
  id: string;
  label: string;
  /** Seconds from the hit until the window reset, if known. */
  lockout: number | null;
}

export function hitRows(hits: readonly LimitHit[], windows: readonly { key: string; label: string }[]): HitRow[] {
  return hits.map((h) => ({
    ...h,
    id: `${h.ts}:${h.kind}`,
    label: hitKindLabel(h.kind, windows),
    lockout: h.resetsAt != null && h.resetsAt > h.ts ? h.resetsAt - h.ts : null,
  }));
}
