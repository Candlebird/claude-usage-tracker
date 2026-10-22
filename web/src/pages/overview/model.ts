import { DAY, HOUR, type LimitWindowStatus, type LiveMinutePoint, type PeriodKpis, type TimeRange, type TimeseriesSeries } from '@ccu/shared';
import { fmtDate, pctChange } from '../../format';

/** five_hour first, then the all-models week, then per-model weeks (by label), then anything else. */
export function windowRank(key: string): number {
  if (key === 'five_hour') return 0;
  if (key === 'seven_day') return 1;
  if (key.startsWith('seven_day:')) return 2;
  return 3;
}

export function sortLimitWindows(windows: readonly LimitWindowStatus[]): LimitWindowStatus[] {
  return [...windows].sort((a, b) => windowRank(a.key) - windowRank(b.key) || a.label.localeCompare(b.label));
}

/**
 * The trailing 7 days in whole hours, ending after the current hour so it is included.
 * Snapping to the hour keeps the request key stable between refresh ticks.
 */
export function lastWeekHourly(now: number): TimeRange {
  const to = Math.floor(now / HOUR) * HOUR + HOUR;
  return { from: to - 7 * DAY, to };
}

/** 7-day daily average vs 30-day daily average, as a percent change. */
export function weekVsMonthPct(last7d: PeriodKpis, last30d: PeriodKpis): number | null {
  if (last30d.costUsd <= 0) return null;
  return pctChange(last7d.costUsd / 7, last30d.costUsd / 30);
}

/** Share of the daily budget spent, 0-100+, or null when no budget is set. */
export function budgetUsedPct(spentUsd: number, budgetUsd: number | null | undefined): number | null {
  if (budgetUsd == null || !(budgetUsd > 0)) return null;
  return (spentUsd / budgetUsd) * 100;
}

export interface SeriesTotal {
  key: string;
  label?: string;
  total: number;
  /** 0-1 share of the sum across all series. */
  share: number;
}

/** Per-series sums, largest first: the numeric companion to a stacked chart. */
export function seriesTotals(series: readonly TimeseriesSeries[]): SeriesTotal[] {
  const totals = series.map((s) => ({ key: s.key, label: s.label, total: s.points.reduce((sum, [, v]) => sum + v, 0) }));
  const all = totals.reduce((sum, t) => sum + t.total, 0);
  return totals
    .filter((t) => t.total > 0)
    .map((t) => ({ ...t, share: all > 0 ? t.total / all : 0 }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

export interface LiveTotals {
  requests: number;
  costUsd: number;
  tokens: number;
  /** Minutes with at least one request. */
  activeMinutes: number;
  /** Largest per-minute cost, for scaling the bars. */
  peakCostUsd: number;
}

export function liveTotals(perMinute: readonly LiveMinutePoint[]): LiveTotals {
  const t: LiveTotals = { requests: 0, costUsd: 0, tokens: 0, activeMinutes: 0, peakCostUsd: 0 };
  for (const p of perMinute) {
    t.requests += p.requests;
    t.costUsd += p.costUsd;
    t.tokens += p.tokens;
    if (p.requests > 0) t.activeMinutes += 1;
    if (p.costUsd > t.peakCostUsd) t.peakCostUsd = p.costUsd;
  }
  return t;
}

/** Top `n` rows by cost; ties break on `tieKey` so the order is stable across refreshes. */
export function topByCost<T extends { costUsd: number }>(rows: readonly T[], n: number, tieKey: (r: T) => string): T[] {
  return [...rows]
    .filter((r) => r.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd || tieKey(a).localeCompare(tieKey(b)))
    .slice(0, n);
}

/** Bar height as a percent of the peak; nonzero values get at least `minPct` so a cheap minute stays visible. */
export function barHeightPct(value: number, peak: number, minPct = 4): number {
  if (!(peak > 0) || !(value > 0)) return 0;
  return Math.max(minPct, Math.min(100, (value / peak) * 100));
}

/** "Last 7d" for presets, "Oct 1 – Oct 9" for a custom range. */
export function rangeLabel(preset: string, range: TimeRange, tz: string): string {
  if (preset !== 'custom') return `Last ${preset}`;
  return `${fmtDate(range.from, tz)} – ${fmtDate(range.to, tz)}`;
}
