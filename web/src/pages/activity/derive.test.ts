import { describe, expect, it } from 'vitest';
import type { CalendarDay, HeatmapCell } from '@ccu/shared';
import { calendarColumns, dayKeyWeekday, levelOf, mondayIndex, monthLabels, peakStats, quantileThresholds, streaks } from './derive';

function day(key: string, requests = 0, costUsd = 0): CalendarDay {
  return { day: key, requests, costUsd, tokens: requests * 100 };
}

/** Contiguous synthetic days starting at `start` (UTC calendar math, no tz involved). */
function days(start: string, n: number, active: (i: number) => number = () => 0): CalendarDay[] {
  const [y, m, d] = start.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const key = new Date(Date.UTC(y!, m! - 1, d! + i)).toISOString().slice(0, 10);
    return day(key, active(i));
  });
}

describe('activity derive', () => {
  it('bins values into quantile levels, with 0 reserved for empty', () => {
    const th = quantileThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(th).toEqual([2, 4, 6, 8, 10]);
    expect(levelOf(0, th)).toBe(0);
    expect(levelOf(1, th)).toBe(1);
    expect(levelOf(5, th)).toBe(3);
    expect(levelOf(10, th)).toBe(5);
    expect(levelOf(50, th)).toBe(5);
    expect(quantileThresholds([0, 0])).toEqual([]);
    expect(levelOf(3, [])).toBe(0);
  });

  it('keeps one outlier from washing out the rest', () => {
    const th = quantileThresholds([1, 1, 1, 1, 1000]);
    expect(levelOf(1, th)).toBeLessThan(levelOf(1000, th));
    expect(levelOf(1, th)).toBeGreaterThan(0);
  });

  it('maps Sunday-first dow to Monday-first rows', () => {
    expect(mondayIndex(0)).toBe(6);
    expect(mondayIndex(1)).toBe(0);
    expect(dayKeyWeekday('2026-10-19')).toBe(0); // a Monday
    expect(dayKeyWeekday('2026-10-25')).toBe(6); // a Sunday
  });

  it('lays the calendar out as Monday-first week columns with a padded first column', () => {
    const cols = calendarColumns(days('2026-10-21', 10)); // Wednesday start
    expect(cols).toHaveLength(2);
    expect(cols[0]!.slice(0, 2)).toEqual([null, null]);
    expect(cols[0]![2]!.day).toBe('2026-10-21');
    expect(cols[0]).toHaveLength(7);
    expect(cols[1]![0]!.day).toBe('2026-10-26');
    expect(cols[1]).toHaveLength(5);
    expect(calendarColumns([])).toEqual([]);
  });

  it('labels months at their first week and avoids a collision at the first column', () => {
    const cols = calendarColumns(days('2026-09-28', 21)); // Oct 1 falls in column 0
    expect(monthLabels(cols, (d) => d.slice(5, 7))[0]).toBe('10');
    const near = calendarColumns(days('2026-09-21', 21)); // Oct 1 in column 1: first column stays blank
    const labels = monthLabels(near, (d) => d.slice(5, 7));
    expect(labels[0]).toBeNull();
    expect(labels[1]).toBe('10');
    const far = calendarColumns(days('2026-10-05', 21)); // no 1st in range: label the first column
    expect(monthLabels(far, (d) => d.slice(5, 7))[0]).toBe('10');
  });

  it('finds the busiest hour and weekday', () => {
    const grid: HeatmapCell[] = [
      { dow: 1, hour: 9, costUsd: 2, tokens: 10, requests: 1 },
      { dow: 1, hour: 14, costUsd: 1, tokens: 50, requests: 5 },
      { dow: 0, hour: 14, costUsd: 4, tokens: 5, requests: 1 },
    ];
    const cost = peakStats(grid, 'costUsd');
    expect(cost.peakHour).toEqual({ index: 14, value: 5 });
    expect(cost.peakWeekday).toEqual({ index: 6, value: 4 }); // Sunday
    expect(cost.total).toBe(7);
    expect(peakStats(grid, 'requests').peakWeekday).toEqual({ index: 0, value: 6 }); // Monday
    expect(peakStats([], 'tokens').peakHour).toBeNull();
  });

  it('counts active days and streaks, letting today be still empty', () => {
    const pattern = [1, 1, 0, 1, 1, 1, 0];
    const s = streaks(days('2026-10-16', 7, (i) => pattern[i]!));
    expect(s.activeDays).toBe(5);
    expect(s.longest).toBe(3);
    expect(s.current).toBe(3);
    expect(streaks(days('2026-10-16', 3, () => 0))).toEqual({ activeDays: 0, current: 0, longest: 0 });
    expect(streaks(days('2026-10-16', 3, (i) => (i === 0 ? 1 : 0))).current).toBe(0);
  });
});
