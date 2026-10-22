import { describe, expect, it } from 'vitest';
import type { ModelRow, TimeseriesSeries } from '@ccu/shared';
import { hitRate, hitRateSeries, mixParts, orderByType, pickTypes, rateStats, totalsFromModels, typeTotals, writeSplit } from './derive';

const typeSeries: TimeseriesSeries[] = [
  { key: 'cacheRead', points: [[100, 80], [200, 0]] },
  { key: 'input', points: [[100, 10], [200, 0]] },
  { key: 'cacheWrite1h', points: [[100, 6], [200, 0]] },
  { key: 'cacheWrite5m', points: [[100, 4], [200, 0]] },
  { key: 'output', points: [[100, 50], [200, 0]] },
  { key: 'bogus', points: [[100, 999]] },
];

function row(over: Partial<ModelRow>): ModelRow {
  return {
    model: 'claude-test-1',
    family: 'test',
    priced: true,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearch: 0,
    totalTokens: 0,
    requests: 0,
    costUsd: 0,
    cacheHitRate: null,
    cacheSavingsUsd: 0,
    costShare: 0,
    tokenShare: 0,
    ...over,
  };
}

describe('models derive', () => {
  it('sums type totals and ignores unknown keys', () => {
    expect(typeTotals(typeSeries)).toEqual({ input: 10, output: 50, cacheRead: 80, cacheWrite5m: 4, cacheWrite1h: 6 });
  });

  it('orders series by token type and picks a subset', () => {
    expect(orderByType(typeSeries).map((s) => s.key)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'bogus']);
    expect(pickTypes(typeSeries, ['cacheWrite1h', 'cacheWrite5m']).map((s) => s.key)).toEqual(['cacheWrite5m', 'cacheWrite1h']);
  });

  it('computes hit rate as cacheRead over all input, excluding output', () => {
    expect(hitRate({ input: 10, cacheRead: 80, cacheWrite5m: 4, cacheWrite1h: 6 })).toBeCloseTo(0.8);
    expect(hitRate({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeNull();
  });

  it('gives a null (gap) for empty buckets in the hit-rate series', () => {
    const pts = hitRateSeries(typeSeries);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ t: 100, rate: 0.8 });
    expect(pts[1]).toEqual({ t: 200, rate: null });
  });

  it('finds best and lowest buckets, skipping gaps', () => {
    const s = rateStats([{ t: 1, rate: 0.5 }, { t: 2, rate: null }, { t: 3, rate: 0.9 }, { t: 4, rate: 0.2 }]);
    expect(s.max).toEqual({ t: 3, rate: 0.9 });
    expect(s.min).toEqual({ t: 4, rate: 0.2 });
    expect(s.active).toBe(3);
    expect(rateStats([]).max).toBeNull();
  });

  it('totals model rows and lists unpriced models', () => {
    const t = totalsFromModels([
      row({ model: 'a', input: 10, cacheRead: 90, costUsd: 2, totalTokens: 100, requests: 3, cacheSavingsUsd: 1 }),
      row({ model: 'b', priced: false, output: 5, totalTokens: 5, requests: 1 }),
    ]);
    expect(t.costUsd).toBe(2);
    expect(t.totalTokens).toBe(105);
    expect(t.requests).toBe(4);
    expect(t.cacheSavingsUsd).toBe(1);
    expect(t.cacheHitRate).toBeCloseTo(0.9);
    expect(t.unpriced).toEqual(['b']);
  });

  it('splits cache writes and prices the 1-hour premium', () => {
    const tokens = typeTotals(typeSeries);
    const s = writeSplit(tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 1.25, cacheWrite1h: 4 });
    expect(s.tokens5m).toBe(4);
    expect(s.tokens1h).toBe(6);
    expect(s.share1h).toBeCloseTo(0.6);
    // 1h is 2x input, 5m is 1.25x: the same tokens at 5m would cost 1.25/2 of the 1h cost.
    expect(s.premium1h).toBeCloseTo(4 * (1 - 1.25 / 2));
    expect(writeSplit({ input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, null)).toMatchObject({ share1h: null, premium1h: 0 });
  });

  it('builds mix parts in fixed order with shares summing to 1', () => {
    const parts = mixParts(typeTotals(typeSeries));
    expect(parts.map((p) => p.type)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']);
    expect(parts.reduce((n, p) => n + p.share, 0)).toBeCloseTo(1);
    expect(mixParts({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }).every((p) => p.share === 0)).toBe(true);
  });
});
