import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDailyLegacyIngest } from '@ccu/shared';
import { describe, expect, it } from 'vitest';
import { chunkRows, earliestTranscriptDay, parseStatsCache, readStatsCache, rowsBefore } from '../src/statsCacheImport.js';
import { emptyState } from '../src/state.js';

// Synthetic, same shape as stats-cache.json v5.
const body = {
  version: 5,
  lastComputedDate: '2026-02-10',
  dailyActivity: [{ date: '2026-01-01', messageCount: 10, sessionCount: 1, toolCallCount: 2 }],
  dailyModelTokens: [
    { date: '2026-01-01', tokensByModel: { 'claude-sonnet-4-5': 1000, 'Claude-Sonnet-4-5[1m]': 500, '<synthetic>': 9 } },
    { date: '2026-01-05', tokensByModel: { 'claude-opus-4-1': 2000, bad: 'x' } },
    { date: 'not-a-date', tokensByModel: { m: 1 } },
    null,
  ],
  modelUsage: {},
};

describe('stats-cache import', () => {
  it('parses per-day per-model token rows with requests = 0', () => {
    const rows = parseStatsCache(body);
    expect(rows).toEqual([
      { day: '2026-01-01', model: 'claude-sonnet-4-5', tokens: 1500, requests: 0 },
      { day: '2026-01-05', model: 'claude-opus-4-1', tokens: 2000, requests: 0 },
    ]);
    expect(validateDailyLegacyIngest({ days: rows }).ok).toBe(true);
  });

  it('keeps only days before the first transcript day', () => {
    const state = emptyState();
    state.reqs['m1'] = [Date.parse('2026-01-05T12:00:00Z') / 1000, 0, 1, 1, 0, 0, 0, 0, 1];
    const first = earliestTranscriptDay(state, 'UTC');
    expect(first).toBe('2026-01-05');
    expect(rowsBefore(parseStatsCache(body), first).map((r) => r.day)).toEqual(['2026-01-01']);
    expect(earliestTranscriptDay(emptyState(), 'UTC')).toBeNull();
  });

  it('reads from disk and reports errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccu-stats-'));
    const p = join(dir, 'stats-cache.json');
    writeFileSync(p, JSON.stringify(body));
    expect(readStatsCache(p).ok).toBe(true);
    writeFileSync(p, '{');
    expect(readStatsCache(p).ok).toBe(false);
    expect(readStatsCache(join(dir, 'missing.json')).ok).toBe(false);
  });

  it('chunks', () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
