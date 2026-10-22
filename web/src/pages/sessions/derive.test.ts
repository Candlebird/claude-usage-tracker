import { describe, expect, it } from 'vitest';
import type { UsageTotals } from '@ccu/shared';
import { cacheHitRate, overheadView, sumCacheFields, tokenParts } from './derive';

const totals = { input: 100, output: 50, cacheRead: 300, cacheWrite5m: 80, cacheWrite1h: 20, totalTokens: 550, requests: 4, costUsd: 1.5 } as UsageTotals;

describe('cacheHitRate', () => {
  it('is cache reads over all prompt tokens, output excluded', () => {
    expect(cacheHitRate(totals)).toBeCloseTo(300 / 500);
  });

  it('is null with no prompt tokens', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeNull();
  });

  it('weights by tokens when aggregated', () => {
    const a = { input: 900, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 };
    const b = { input: 0, cacheRead: 10, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(cacheHitRate(sumCacheFields([a, b]))).toBeCloseTo(110 / 1010);
  });
});

describe('tokenParts', () => {
  it('lists the five token types in a fixed order', () => {
    expect(tokenParts(totals).map((p) => [p.key, p.value])).toEqual([
      ['input', 100],
      ['output', 50],
      ['cacheRead', 300],
      ['cacheWrite5m', 80],
      ['cacheWrite1h', 20],
    ]);
    for (const p of tokenParts(totals)) {
      expect(p.label).toBeTruthy();
      expect(p.color).toBeTruthy();
    }
  });
});

describe('overheadView', () => {
  it('reports a missing cost-state record', () => {
    expect(overheadView({ costUsd: 2, costStateUsd: null })).toEqual({ kind: 'missing', transcriptUsd: 2 });
  });

  it('reports extra cost outside the transcripts', () => {
    const v = overheadView({ costUsd: 9, costStateUsd: 10 });
    expect(v).toMatchObject({ kind: 'extra', costStateUsd: 10 });
    if (v.kind === 'missing') throw new Error('unexpected');
    expect(v.diffUsd).toBeCloseTo(1);
    expect(v.share).toBeCloseTo(0.1);
  });

  it('treats sub-cent differences as none', () => {
    expect(overheadView({ costUsd: 1, costStateUsd: 1.001 }).kind).toBe('none');
  });

  it('flags a cost-state total below the transcripts', () => {
    expect(overheadView({ costUsd: 5, costStateUsd: 4 })).toMatchObject({ kind: 'under', diffUsd: -1 });
  });

  it('has no share when the cost-state total is zero', () => {
    expect(overheadView({ costUsd: 1, costStateUsd: 0 })).toMatchObject({ kind: 'under', share: null });
  });
});
