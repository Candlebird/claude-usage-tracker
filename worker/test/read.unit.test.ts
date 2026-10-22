import { DAY, HOUR, localToUnix } from '@ccu/shared';
import { describe, expect, it } from 'vitest';
import { DayIndex } from '../src/routes/read-days.js';
import { blockDrafts, buildBlocks, windowStatus, type SnapshotRow } from '../src/routes/read-limits.js';
import { estimateRowsWritten } from '../src/routes/read-ops.js';
import { sessionRow } from '../src/routes/read-sessions.js';
import { BURN_WINDOW, burnRate, MIN_BURN_SPAN } from '../src/routes/read-summary.js';
import { typeValues } from '../src/routes/read-usage.js';

const TZ = 'America/Denver';
const NOW = localToUnix(2027, 1, 15, 14, 10, TZ);
const H = NOW - (NOW % HOUR);

describe('burnRate', () => {
  it('prorates synced hours up to the last sync and adds live only for the tail', () => {
    const r = burnRate(
      [
        { hour: H - HOUR, costUsd: 6, tokens: 600, requests: 6 },
        { hour: H, costUsd: 1, tokens: 60, requests: 1 },
      ],
      { requests: 1, costUsd: 0.5, tokens: 30 },
      NOW - 300,
      NOW,
    );
    expect(r.costPerHour).toBeCloseTo(6.5, 6);
    expect(r.source).toBe('merged');
    expect(r.windowMinutes).toBe(60);
  });

  it('falls back to live only, or hourly only', () => {
    expect(burnRate([], { requests: 2, costUsd: 1, tokens: 120 }, null, NOW)).toMatchObject({ source: 'live', costPerHour: 1, tokensPerMinute: 2 });
    const hourly = burnRate([{ hour: H - HOUR, costUsd: 6, tokens: 0, requests: 1 }], null, NOW, NOW);
    expect(hourly.source).toBe('hourly');
    expect(hourly.costPerHour).toBeCloseTo(5, 6);
  });

  it('divides by the synced span when no live rows cover the tail', () => {
    // Sync 30 min stale; the bucket holds $4/3 spread over [H-1h, lastSync), so $1 falls in the window.
    const lastSync = NOW - 1800;
    const r = burnRate([{ hour: H - HOUR, costUsd: 4 / 3, tokens: 0, requests: 4 }], null, lastSync, NOW);
    expect(r.windowMinutes).toBe(30);
    expect(r.costPerHour).toBeCloseTo(2, 6);
    // Live rows make the full hour observed again.
    const merged = burnRate([{ hour: H - HOUR, costUsd: 4 / 3, tokens: 0, requests: 4 }], { requests: 1, costUsd: 0.5, tokens: 0 }, lastSync, NOW);
    expect(merged.windowMinutes).toBe(60);
    expect(merged.costPerHour).toBeCloseTo(1.5, 6);
  });

  it('never divides by less than the minimum span', () => {
    const r = burnRate([], null, NOW - BURN_WINDOW + 10, NOW);
    expect(r.windowMinutes).toBe(MIN_BURN_SPAN / 60);
    expect(r.costPerHour).toBe(0);
  });
});

describe('5-hour blocks', () => {
  const snap = (ts: number, utilization: number, resetsAt: number): SnapshotRow => ({ key: 'five_hour', ts, utilization, resetsAt, severity: null });

  it('clusters by reset time within tolerance and drops post-reset snapshots', () => {
    const R = H + 2 * HOUR;
    const drafts = blockDrafts([snap(R - 4 * HOUR, 10, R), snap(R - HOUR, 60, R + 60), snap(R + 10, 99, R), snap(R + HOUR, 5, R + 5 * HOUR)]);
    expect(drafts).toEqual([
      { end: R + 60, latestTs: R - HOUR, peak: 60 },
      { end: R + 5 * HOUR, latestTs: R + HOUR, peak: 5 },
    ]);
  });

  it('assigns hours by midpoint and computes cost per 1%', () => {
    const end = H + 2 * HOUR;
    const blocks = buildBlocks(
      [{ end, latestTs: NOW, peak: 50 }, { end: end - 20 * HOUR, latestTs: 0, peak: 0 }],
      [
        { hour: end - 5 * HOUR, costUsd: 2, tokens: 10, requests: 1 },
        { hour: end - HOUR, costUsd: 3, tokens: 5, requests: 1 },
        { hour: end, costUsd: 100, tokens: 1, requests: 1 },
      ],
      NOW - 30 * HOUR,
      NOW,
      NOW,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.costPerPercent).toBeNull();
    expect(blocks[1]).toMatchObject({ start: end - 5 * HOUR, costUsd: 5, tokens: 15, costPerPercent: 0.1, active: true });
  });
});

describe('windowStatus', () => {
  it('reports pace inside the window and zeroes after reset', () => {
    const live = windowStatus({ key: 'five_hour', ts: NOW, utilization: 40, resetsAt: NOW + 3 * HOUR, severity: null }, NOW);
    expect(live.elapsedFraction).toBeCloseTo(0.4, 6);
    expect(live.pace).not.toBeNull();
    const past = windowStatus({ key: 'five_hour', ts: NOW - 6 * HOUR, utilization: 90, resetsAt: NOW - HOUR, severity: null }, NOW);
    expect(past).toMatchObject({ utilization: 0, elapsedFraction: 1, pace: null });
  });
});

describe('DayIndex', () => {
  it('handles a DST spring-forward day (23 hours)', () => {
    const start = localToUnix(2027, 3, 14, 0, 0, TZ);
    const idx = new DayIndex(start - DAY, start + 47 * HOUR - 1, TZ);
    expect(idx.days).toEqual(['2027-03-13', '2027-03-14', '2027-03-15']);
    expect(idx.starts[2]! - idx.starts[1]!).toBe(23 * HOUR);
    const i = idx.indexOf(start + 3 * HOUR);
    expect(i).toBe(1);
    // 02:00 local does not exist: start + 2h is already 03:00 MDT.
    expect(idx.localHour(start + 2 * HOUR + 1800, i)).toBe(3);
    expect(idx.indexOfHour(start - HOUR)).toBe(0);
    expect(idx.indexOf(idx.end)).toBe(-1);
    expect(idx.dow(1)).toBe(0);
  });
});

describe('typeValues', () => {
  const row = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, requests: 3, costUsd: 36 };

  it('splits cost by type, scaled to the stored cost', () => {
    const parts = Object.fromEntries(typeValues(row, 'claude-sonnet-4-5', 'cost'));
    // Base prices 3 and 15 sum to 18; stored cost 36 doubles each part.
    expect(parts.input).toBeCloseTo(6, 6);
    expect(parts.output).toBeCloseTo(30, 6);
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBeCloseTo(36, 6);
  });

  it('passes tokens and requests through, zero for unpriced models', () => {
    expect(typeValues(row, 'claude-sonnet-4-5', 'requests')).toEqual([['requests', 3]]);
    expect(Object.fromEntries(typeValues(row, 'x', 'tokens')).output).toBe(1_000_000);
    expect(typeValues(row, 'mystery-model', 'cost').every(([, v]) => v === 0)).toBe(true);
  });
});

describe('estimateRowsWritten and sessionRow', () => {
  it('estimates rows written', () => {
    expect(estimateRowsWritten(2, 150, 2, 1)).toBe(309);
  });

  it('computes duration and untracked overhead', () => {
    const base = {
      sessionId: 's',
      project: 'p',
      projectLabel: 'P',
      title: null,
      gitBranch: null,
      models: '["claude-sonnet-4-5"]',
      firstTs: 100,
      lastTs: 400,
      agentCount: null,
      costStateUsd: 2,
      linesAdded: null,
      linesRemoved: null,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      webSearch: 0,
      requests: 1,
      costUsd: 1.25,
    };
    expect(sessionRow(base)).toMatchObject({ durationSeconds: 300, untrackedOverheadUsd: 0.75, agentCount: 0, models: ['claude-sonnet-4-5'] });
    expect(sessionRow({ ...base, costStateUsd: null, models: 'not json' })).toMatchObject({ untrackedOverheadUsd: null, models: [] });
    // Buckets still pending upload: the overhead would be inflated, so it is unknown.
    expect(sessionRow(base, true)).toMatchObject({ costStateUsd: 2, untrackedOverheadUsd: null });
  });
});
