import type { CalendarDay, HeatmapCell } from '@ccu/shared';

export type ActivityMetric = 'costUsd' | 'tokens' | 'requests';

type Measured = Pick<HeatmapCell, ActivityMetric>;

export function metricValue(m: Measured | undefined, metric: ActivityMetric): number {
  return m ? m[metric] : 0;
}

/**
 * Upper bounds for `levels` quantile bins over the non-zero values, so a few huge days
 * don't wash every other cell into the lightest step. Returns ascending thresholds;
 * level i covers values <= thresholds[i-1].
 */
export function quantileThresholds(values: readonly number[], levels = 5): number[] {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return [];
  const out: number[] = [];
  for (let i = 1; i <= levels; i++) {
    const idx = Math.min(nz.length - 1, Math.ceil((i / levels) * nz.length) - 1);
    out.push(nz[idx]!);
  }
  return out;
}

/** 0 for empty, else 1..thresholds.length. */
export function levelOf(v: number, thresholds: readonly number[]): number {
  if (!(v > 0) || thresholds.length === 0) return 0;
  for (let i = 0; i < thresholds.length; i++) if (v <= thresholds[i]!) return i + 1;
  return thresholds.length;
}

/** Monday-first weekday index (0 = Mon .. 6 = Sun) from the API's Sunday-first dow. */
export function mondayIndex(dow: number): number {
  return (dow + 6) % 7;
}

/** Monday-first weekday of a `YYYY-MM-DD` key, independent of the browser tz. */
export function dayKeyWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return mondayIndex(new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay());
}

/** Calendar as week columns (Mon..Sun). The first column is padded with nulls before the first day. */
export function calendarColumns(days: readonly CalendarDay[]): (CalendarDay | null)[][] {
  const cols: (CalendarDay | null)[][] = [];
  if (days.length === 0) return cols;
  let col: (CalendarDay | null)[] = Array.from({ length: dayKeyWeekday(days[0]!.day) }, () => null);
  for (const d of days) {
    if (col.length === 7) {
      cols.push(col);
      col = [];
    }
    col.push(d);
  }
  cols.push(col);
  return cols;
}

/** Month label per column: shown on the first column containing the 1st of a month, else the first column. */
export function monthLabels(cols: readonly (CalendarDay | null)[][], fmt: (day: string) => string): (string | null)[] {
  const out = cols.map((col) => {
    const first = col.find((d) => d && d.day.endsWith('-01'));
    return first ? fmt(first.day) : null;
  });
  // Label the first column only when the next month label is at least 3 columns away, so they don't collide.
  const firstDay = cols[0]?.find((d) => d)?.day;
  if (firstDay && out[0] == null) {
    const next = out.findIndex((l) => l != null);
    if (next === -1 || next >= 3) out[0] = fmt(firstDay);
  }
  return out;
}

export interface Peak {
  index: number;
  value: number;
}

function argmax(values: readonly number[]): Peak | null {
  let best: Peak | null = null;
  values.forEach((value, index) => {
    if (value > 0 && (!best || value > best.value)) best = { index, value };
  });
  return best;
}

export interface PeakStats {
  /** Totals by hour of day (0-23). */
  byHour: number[];
  /** Totals by Monday-first weekday (0 = Mon). */
  byWeekday: number[];
  peakHour: Peak | null;
  peakWeekday: Peak | null;
  total: number;
}

export function peakStats(grid: readonly HeatmapCell[], metric: ActivityMetric): PeakStats {
  const byHour = Array.from({ length: 24 }, () => 0);
  const byWeekday = Array.from({ length: 7 }, () => 0);
  let total = 0;
  for (const c of grid) {
    const v = metricValue(c, metric);
    if (c.hour >= 0 && c.hour < 24) byHour[c.hour]! += v;
    if (c.dow >= 0 && c.dow < 7) byWeekday[mondayIndex(c.dow)]! += v;
    total += v;
  }
  return { byHour, byWeekday, peakHour: argmax(byHour), peakWeekday: argmax(byWeekday), total };
}

export interface StreakStats {
  activeDays: number;
  /** Consecutive active days ending today, or yesterday when today has no usage yet. */
  current: number;
  longest: number;
}

/** `days` must be oldest-first and contiguous (the API zero-fills). Activity means at least one request. */
export function streaks(days: readonly CalendarDay[]): StreakStats {
  let activeDays = 0;
  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (d.requests > 0) {
      activeDays++;
      run++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i]!.requests === 0) i--;
  for (; i >= 0 && days[i]!.requests > 0; i--) current++;
  return { activeDays, current, longest };
}
