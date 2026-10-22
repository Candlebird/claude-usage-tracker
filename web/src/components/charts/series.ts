import type { TimeseriesSeries } from '@ccu/shared';
import { MAX_SERIES, OTHER_KEY } from '../../palette';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export type ChartRow = { t: number } & Record<string, number>;

function seriesTotal(s: TimeseriesSeries): number {
  let n = 0;
  for (const [, v] of s.points) n += v;
  return n;
}

/**
 * Keeps at most `max` series. When there are more, the largest `max - 1` stay and
 * the rest are summed into one "Other" series (key OTHER_KEY). Input order is kept
 * for the survivors, so colors that follow the entity do not move.
 */
export function foldOther(series: readonly TimeseriesSeries[], max = MAX_SERIES, otherLabel = 'Other'): TimeseriesSeries[] {
  if (series.length <= max) return [...series];
  const ranked = [...series].sort((a, b) => seriesTotal(b) - seriesTotal(a));
  const keep = new Set(ranked.slice(0, max - 1).map((s) => s.key));
  const sums = new Map<number, number>();
  for (const s of series) {
    if (keep.has(s.key)) continue;
    for (const [t, v] of s.points) sums.set(t, (sums.get(t) ?? 0) + v);
  }
  const other: TimeseriesSeries = {
    key: OTHER_KEY,
    label: otherLabel,
    points: [...sums.entries()].sort((a, b) => a[0] - b[0]),
  };
  return [...series.filter((s) => keep.has(s.key)), other];
}

/** Pivots series into one row per timestamp ({ t, [key]: value }), filling gaps with 0. */
export function toRows(series: readonly TimeseriesSeries[]): ChartRow[] {
  const byT = new Map<number, ChartRow>();
  for (const s of series) {
    for (const [t, v] of s.points) {
      let row = byT.get(t);
      if (!row) byT.set(t, (row = { t } as ChartRow));
      row[s.key] = (row[s.key] ?? 0) + v;
    }
  }
  const rows = [...byT.values()].sort((a, b) => a.t - b.t);
  for (const row of rows) for (const s of series) row[s.key] ??= 0;
  return rows;
}

/** Sum of every series at each row; handy for tooltip totals and empty checks. */
export function rowTotal(row: ChartRow, keys: readonly string[]): number {
  let n = 0;
  for (const k of keys) n += row[k] ?? 0;
  return n;
}

export function isAllZero(series: readonly TimeseriesSeries[]): boolean {
  return series.every((s) => s.points.every(([, v]) => !v));
}
