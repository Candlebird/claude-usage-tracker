import { DEFAULT_SETTINGS, type Settings, type SyncRun } from '@ccu/shared';
import { describe, expect, it } from 'vitest';
import {
  buildUpdate,
  dataQualityHealth,
  hasErrors,
  latestErrors,
  liveHealth,
  parseThresholds,
  pricingHealth,
  quotaUsage,
  secondsToUtcMidnight,
  syncHealth,
  syncRunsWithin,
  toDraft,
  toTableRows,
} from './logic';

const NOW = 1_760_000_000;
const MIN = 60;

const base: Settings = {
  ...DEFAULT_SETTINGS,
  dailyBudgetUsd: 60,
  alertThresholds: { fiveHour: [75, 90], weekly: [75, 90] },
  weeklyPaceAlert: true,
  staleSyncMinutes: 60,
  ntfyEnabled: true,
};

const run = (ts: number, errors: string[] = []): SyncRun => ({ ts, device: 'pc', rows: 1, pending: 0, version: '2.0.0', errors });

describe('syncHealth', () => {
  it('grades by age against the stale window', () => {
    expect(syncHealth(null, NOW, 60).status).toBe('critical');
    expect(syncHealth(NOW - 4 * MIN, NOW, 60)).toEqual({ status: 'ok', label: 'Up to date' });
    expect(syncHealth(NOW - 30 * MIN, NOW, 60)).toEqual({ status: 'warning', label: 'Behind' });
    expect(syncHealth(NOW - 61 * MIN, NOW, 60)).toEqual({ status: 'critical', label: 'Stale' });
  });

  it('never reports stale inside the normal 15 minute slack, even with a tiny window', () => {
    expect(syncHealth(NOW - 15 * MIN, NOW, 10).status).toBe('ok');
    expect(syncHealth(NOW - 16 * MIN, NOW, 10).status).toBe('critical');
  });
});

describe('liveHealth', () => {
  it('treats quiet streams as normal and only flags never or days of silence', () => {
    expect(liveHealth(null, NOW)).toEqual({ status: 'warning', label: 'Never received' });
    expect(liveHealth(NOW - 5 * MIN, NOW).label).toBe('Receiving');
    expect(liveHealth(NOW - 24 * 3600, NOW)).toEqual({ status: 'ok', label: 'Idle' });
    expect(liveHealth(NOW - 4 * 86_400, NOW).status).toBe('warning');
  });
});

describe('quotaUsage', () => {
  it('computes percent and grades at 70 and 90', () => {
    expect(quotaUsage(5_000, 100_000)).toMatchObject({ pct: 5, health: { status: 'ok' } });
    expect(quotaUsage(75_000, 100_000).health.label).toBe('Approaching quota');
    expect(quotaUsage(100_000, 100_000).health).toEqual({ status: 'critical', label: 'Quota reached' });
  });

  it('handles a zero limit', () => {
    expect(quotaUsage(10, 0).pct).toBe(0);
  });
});

describe('data quality', () => {
  it('warns on unpriced models before incomplete outputs', () => {
    expect(pricingHealth([])).toEqual({ status: 'ok', label: 'All priced' });
    expect(pricingHealth(['m-a', 'm-b']).label).toBe('2 unpriced models');
    expect(dataQualityHealth({ unpricedModels: ['m-a'], outputIncomplete: { requests: 3, reportedTs: NOW } })).toEqual({ status: 'warning', label: '1 unpriced model' });
    expect(dataQualityHealth({ unpricedModels: [], outputIncomplete: { requests: 3, reportedTs: NOW } }).label).toBe('Minor gaps');
    expect(dataQualityHealth({ unpricedModels: [], outputIncomplete: { requests: 0, reportedTs: null } }).label).toBe('Clean');
  });
});

describe('sync runs', () => {
  it('counts runs within a window', () => {
    expect(syncRunsWithin([run(NOW - 60), run(NOW - 3000), run(NOW - 4000)], NOW, 3600)).toBe(2);
  });

  it('returns deduped errors from the newest failing run', () => {
    const runs = [run(NOW - 300), run(NOW - 600, ['timeout', 'timeout', '429']), run(NOW - 900, ['old'])];
    expect(latestErrors(runs)).toEqual({ ts: NOW - 600, errors: ['timeout', '429'] });
    expect(latestErrors([run(NOW)])).toBeNull();
  });
});

describe('storage helpers', () => {
  it('seconds to UTC midnight', () => {
    expect(secondsToUtcMidnight(86_400 * 10)).toBe(86_400);
    expect(secondsToUtcMidnight(86_400 * 10 + 86_399)).toBe(1);
  });

  it('table shares sum to 1 and survive an empty map', () => {
    const rows = toTableRows({ a: 30, b: 10 });
    expect(rows).toEqual([
      { table: 'a', rows: 30, share: 0.75 },
      { table: 'b', rows: 10, share: 0.25 },
    ]);
    expect(toTableRows({ a: 0 })[0]!.share).toBe(0);
  });
});

describe('parseThresholds', () => {
  it('accepts commas, spaces and percent signs, then sorts and dedupes', () => {
    expect(parseThresholds('90, 75%')).toEqual([75, 90]);
    expect(parseThresholds('50 50;80.4')).toEqual([50, 80]);
  });

  it('rejects empty, out of range, junk and too many', () => {
    expect(typeof parseThresholds(' ')).toBe('string');
    expect(typeof parseThresholds('0, 50')).toBe('string');
    expect(typeof parseThresholds('101')).toBe('string');
    expect(typeof parseThresholds('abc')).toBe('string');
    expect(typeof parseThresholds('10,20,30,40,50')).toBe('string');
  });
});

describe('buildUpdate', () => {
  it('sends nothing when the draft matches', () => {
    expect(buildUpdate(base, toDraft(base))).toEqual({ errors: {}, update: {} });
  });

  it('sends only changed fields, rounding money to cents', () => {
    const draft = { ...toDraft(base), dailyBudgetUsd: '12.345', weeklyPaceAlert: false };
    expect(buildUpdate(base, draft).update).toEqual({ dailyBudgetUsd: 12.35, weeklyPaceAlert: false });
  });

  it('sends both threshold lists together when either changes', () => {
    const draft = { ...toDraft(base), weekly: '50, 90' };
    expect(buildUpdate(base, draft).update).toEqual({ alertThresholds: { fiveHour: [75, 90], weekly: [50, 90] } });
  });

  it('reports per-field errors', () => {
    const draft = { ...toDraft(base), dailyBudgetUsd: '-1', fiveHour: '', staleSyncMinutes: '5' };
    const { errors, update } = buildUpdate(base, draft);
    expect(Object.keys(errors).sort()).toEqual(['dailyBudgetUsd', 'fiveHour', 'staleSyncMinutes']);
    expect(hasErrors(errors)).toBe(true);
    expect(update.alertThresholds).toBeUndefined();
  });

  it('rejects fractional stale minutes', () => {
    expect(buildUpdate(base, { ...toDraft(base), staleSyncMinutes: '30.5' }).errors.staleSyncMinutes).toBeDefined();
  });
});
