import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCacheFile, readCacheFile, writeCacheFile } from '../src/cache.js';

const NOW = 1772370000;
const snapshot = {
  ts: NOW,
  windows: [{ key: 'five_hour', label: '5-hour session', utilization: 40, resetsAt: '2026-03-01T15:00:00Z', severity: 'normal' }],
};
const base = { now: NOW, tz: 'UTC', today: { costUsd: 1.5, tokens: 100, requests: 3 }, burnRatePerHour: 0.5, pending: 0 };

describe('cache file', () => {
  it('builds windows with unix resets and round-trips through disk', () => {
    const c = buildCacheFile({ ...base, prev: null, limits: { snapshot, extraUsageEnabled: true }, syncedTs: NOW, errors: [] });
    expect(c.limits.windows[0]).toEqual({ key: 'five_hour', label: '5-hour session', utilization: 40, resetsAt: Date.parse('2026-03-01T15:00:00Z') / 1000, severity: 'normal' });
    expect(c.today.day).toBe('2026-03-01');
    const p = join(mkdtempSync(join(tmpdir(), 'ccu-cache-')), 'sub', 'cache.json');
    writeCacheFile(p, c);
    expect(readCacheFile(p)).toEqual(c);
  });

  it('keeps previous limits and lastSyncTs when this run had none', () => {
    const prev = buildCacheFile({ ...base, prev: null, limits: { snapshot, extraUsageEnabled: null }, syncedTs: NOW - 300, errors: [] });
    const c = buildCacheFile({ ...base, now: NOW + 300, prev, limits: null, syncedTs: null, errors: [{ source: 'usageApi', message: 'usage API timed out' }] });
    expect(c.lastSyncTs).toBe(NOW - 300);
    expect(c.limits).toEqual(prev.limits);
    expect(c.errors).toEqual([{ ts: NOW + 300, source: 'usageApi', message: 'usage API timed out' }]);
  });

  it('ages out old errors and clamps long messages', () => {
    const prev = buildCacheFile({ ...base, prev: null, limits: null, syncedTs: null, errors: [{ source: 'x', message: 'old' }] });
    const c = buildCacheFile({ ...base, now: NOW + 2 * 86400, prev, limits: null, syncedTs: null, errors: [{ source: 'y', message: 'm'.repeat(1000) }] });
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]!.message.length).toBeLessThanOrEqual(300);
  });
});
