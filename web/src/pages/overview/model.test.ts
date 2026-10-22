import { describe, expect, it } from 'vitest';
import type { LimitWindowStatus, PeriodKpis } from '@ccu/shared';
import {
  barHeightPct,
  budgetUsedPct,
  lastWeekHourly,
  liveTotals,
  rangeLabel,
  seriesTotals,
  sortLimitWindows,
  topByCost,
  weekVsMonthPct,
  windowRank,
} from './model';

function win(key: string, label: string, utilization: number): LimitWindowStatus {
  return {
    key,
    label,
    utilization,
    resetsAt: 0,
    severity: 'ok',
    snapshotTs: 0,
    windowSeconds: 0,
    elapsedFraction: 0,
    pace: null,
    projectedFullAt: null,
    projectedAtReset: null,
  } as unknown as LimitWindowStatus;
}

function kpis(costUsd: number): PeriodKpis {
  return { costUsd } as PeriodKpis;
}

describe('limit windows', () => {
  it('ranks five-hour, weekly, then per-model weeks', () => {
    expect(windowRank('five_hour')).toBe(0);
    expect(windowRank('seven_day')).toBe(1);
    expect(windowRank('seven_day:opus')).toBe(2);
    expect(windowRank('something_else')).toBe(3);
  });

  it('sorts by rank, then label', () => {
    const sorted = sortLimitWindows([
      win('seven_day:sonnet', 'Weekly Sonnet', 1),
      win('extra', 'Extra', 1),
      win('seven_day', 'Weekly', 1),
      win('seven_day:opus', 'Weekly Opus', 1),
      win('five_hour', '5-hour', 1),
    ]);
    expect(sorted.map((w) => w.key)).toEqual(['five_hour', 'seven_day', 'seven_day:opus', 'seven_day:sonnet', 'extra']);
  });

  it('does not mutate its input', () => {
    const input = [win('seven_day', 'Weekly', 1), win('five_hour', '5-hour', 1)];
    sortLimitWindows(input);
    expect(input[0]!.key).toBe('seven_day');
  });
});

describe('lastWeekHourly', () => {
  it('ends after the current hour and spans 7 days', () => {
    const now = 1_000_000_000 + 1234;
    const r = lastWeekHourly(now);
    expect(r.to % 3600).toBe(0);
    expect(r.to).toBeGreaterThan(now);
    expect(r.to - now).toBeLessThanOrEqual(3600);
    expect(r.to - r.from).toBe(7 * 86400);
  });

  it('is stable within an hour', () => {
    const base = Math.floor(1_700_000_000 / 3600) * 3600;
    expect(lastWeekHourly(base + 1)).toEqual(lastWeekHourly(base + 3599));
  });
});

describe('KPI helpers', () => {
  it('compares the 7-day daily average with the 30-day one', () => {
    expect(weekVsMonthPct(kpis(70), kpis(300))).toBeCloseTo(0);
    expect(weekVsMonthPct(kpis(140), kpis(300))).toBeCloseTo(100);
    expect(weekVsMonthPct(kpis(10), kpis(0))).toBeNull();
  });

  it('returns budget use only when a budget is set', () => {
    expect(budgetUsedPct(5, null)).toBeNull();
    expect(budgetUsedPct(5, 0)).toBeNull();
    expect(budgetUsedPct(5, 20)).toBe(25);
    expect(budgetUsedPct(30, 20)).toBe(150);
  });
});

describe('seriesTotals', () => {
  it('sums, drops zero series and sorts by total', () => {
    const t = seriesTotals([
      { key: 'a', points: [[0, 1], [3600, 2]] },
      { key: 'b', points: [[0, 6]] },
      { key: 'z', points: [[0, 0]] },
    ]);
    expect(t.map((x) => x.key)).toEqual(['b', 'a']);
    expect(t[0]!.total).toBe(6);
    expect(t[0]!.share).toBeCloseTo(6 / 9);
    expect(t[1]!.share).toBeCloseTo(3 / 9);
  });

  it('handles no data', () => {
    expect(seriesTotals([])).toEqual([]);
  });
});

describe('live helpers', () => {
  it('totals per-minute points', () => {
    const t = liveTotals([
      { t: 0, requests: 2, costUsd: 0.5, tokens: 100 },
      { t: 60, requests: 0, costUsd: 0, tokens: 0 },
      { t: 120, requests: 1, costUsd: 1.25, tokens: 40 },
    ]);
    expect(t).toEqual({ requests: 3, costUsd: 1.75, tokens: 140, activeMinutes: 2, peakCostUsd: 1.25 });
  });

  it('scales bars to the peak with a visible minimum', () => {
    expect(barHeightPct(0, 10)).toBe(0);
    expect(barHeightPct(5, 0)).toBe(0);
    expect(barHeightPct(10, 10)).toBe(100);
    expect(barHeightPct(5, 10)).toBe(50);
    expect(barHeightPct(0.001, 10)).toBe(4);
  });
});

describe('topByCost', () => {
  it('takes the top n by cost with a stable tie-break and skips zero rows', () => {
    const rows = [
      { id: 'b', costUsd: 5 },
      { id: 'a', costUsd: 5 },
      { id: 'c', costUsd: 9 },
      { id: 'd', costUsd: 0 },
      { id: 'e', costUsd: 1 },
    ];
    expect(topByCost(rows, 3, (r) => r.id).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(topByCost(rows, 10, (r) => r.id).map((r) => r.id)).toEqual(['c', 'a', 'b', 'e']);
  });
});

describe('rangeLabel', () => {
  it('names presets and formats custom ranges', () => {
    expect(rangeLabel('7d', { from: 0, to: 1 }, 'UTC')).toBe('Last 7d');
    expect(rangeLabel('custom', { from: Date.UTC(2026, 0, 2) / 1000, to: Date.UTC(2026, 0, 9) / 1000 }, 'UTC')).toMatch(/Jan 2.*Jan 9/);
  });
});
