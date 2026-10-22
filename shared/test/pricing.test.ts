import { describe, expect, it } from 'vitest';
import {
  PRICING,
  cacheSavings,
  cleanModelId,
  costDetail,
  costOf,
  isPriced,
  normalizeModel,
  priceFor,
} from '../src/pricing.js';
import { emptyUsage, tokensFromApiUsage } from '../src/usage.js';
import type { UsageTokens } from '../src/types.js';

const M = 1_000_000;
const u = (p: Partial<UsageTokens>): UsageTokens => ({ ...emptyUsage(), ...p });

describe('PRICING table', () => {
  it('carries asOf and source', () => {
    expect(PRICING.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICING.source).toMatch(/^https:\/\//);
  });

  it('derives cache writes as 1.25x / 2x input for every model', () => {
    for (const [key, p] of Object.entries(PRICING.models)) {
      expect(p.cacheWrite5m, key).toBeCloseTo(p.input * 1.25, 10);
      expect(p.cacheWrite1h, key).toBeCloseTo(p.input * 2, 10);
    }
  });
});

describe('costOf per model family (1M of each token type)', () => {
  const cases: Array<[string, number, number, number]> = [
    // model, input, output, cacheRead
    ['claude-fable-5-1', 10, 50, 0.25],
    ['claude-mythos-5-1', 10, 50, 0.25],
    ['claude-fable-5', 10, 50, 1],
    ['claude-mythos-5', 10, 50, 1],
    ['claude-opus-5-5', 4, 20, 0.2],
    ['claude-opus-5', 5, 25, 0.5],
    ['claude-opus-4-8', 5, 25, 0.5],
    ['claude-opus-4-7', 5, 25, 0.5],
    ['claude-opus-4-6', 5, 25, 0.5],
    ['claude-opus-4-5', 5, 25, 0.5],
    ['claude-opus-4-1', 15, 75, 1.5],
    ['claude-opus-4', 15, 75, 1.5],
    ['claude-sonnet-5-5', 2, 10, 0.1],
    ['claude-sonnet-5', 2, 10, 0.2],
    ['claude-sonnet-4-6', 3, 15, 0.3],
    ['claude-sonnet-4-5', 3, 15, 0.3],
    ['claude-sonnet-4', 3, 15, 0.3],
    ['claude-haiku-5-5', 0.1, 0.5, 0.01],
    ['claude-haiku-4-5', 1, 5, 0.1],
    ['claude-3-7-sonnet', 3, 15, 0.3],
    ['claude-3-5-sonnet', 3, 15, 0.3],
    ['claude-3-5-haiku', 0.8, 4, 0.08],
    ['claude-3-opus', 15, 75, 1.5],
    ['claude-3-haiku', 0.25, 1.25, 0.03],
  ];

  // 10k tokens stays under every long-prompt tier, so this checks base prices.
  const N = 10_000;
  it.each(cases)('%s', (model, input, output, cacheRead) => {
    const per = (usd: number) => (usd * N) / M;
    expect(costOf(u({ input: N }), model)).toBeCloseTo(per(input), 12);
    expect(costOf(u({ output: N }), model)).toBeCloseTo(per(output), 12);
    expect(costOf(u({ cacheRead: N }), model)).toBeCloseTo(per(cacheRead), 12);
    expect(costOf(u({ cacheWrite5m: N }), model)).toBeCloseTo(per(input * 1.25), 12);
    expect(costOf(u({ cacheWrite1h: N }), model)).toBeCloseTo(per(input * 2), 12);
  });

  it('covers every table key', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual(Object.keys(PRICING.models).sort());
  });

  it('sums a mixed request', () => {
    // sonnet-4-6: 1000 in, 500 out, 20k read, 2k w5m, 1k w1h
    const cost = costOf(u({ input: 1000, output: 500, cacheRead: 20000, cacheWrite5m: 2000, cacheWrite1h: 1000 }), 'claude-sonnet-4-6');
    const expected = (1000 * 3 + 500 * 15 + 20000 * 0.3 + 2000 * 3.75 + 1000 * 6) / M;
    expect(cost).toBeCloseTo(expected, 12);
  });
});

describe('5m vs 1h cache writes', () => {
  it('1h writes cost 1.6x 5m writes', () => {
    const w5 = costOf(u({ cacheWrite5m: 10000 }), 'claude-opus-4-7');
    const w1 = costOf(u({ cacheWrite1h: 10000 }), 'claude-opus-4-7');
    expect(w5).toBeCloseTo(10000 * 6.25 / M, 12);
    expect(w1).toBeCloseTo(10000 * 10 / M, 12);
    expect(w1 / w5).toBeCloseTo(1.6, 10);
  });
});

describe('fast mode', () => {
  it('uses fast input/output and scales cache prices', () => {
    const tokens = u({ input: M, output: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: M });
    const d = costDetail(tokens, 'claude-opus-4-8', { speed: 'fast' });
    expect(d.fast).toBe(true);
    // 10 + 50 + 0.5*2 + 12.5 + 20
    expect(d.costUsd).toBeCloseTo(10 + 50 + 1 + 12.5 + 20, 10);
  });

  it('opus-5-5 fast prices', () => {
    expect(costOf(u({ input: M, output: M }), 'claude-opus-5-5', { speed: 'fast' })).toBeCloseTo(48, 10);
    expect(costOf(u({ cacheRead: M }), 'claude-opus-5-5', { speed: 'fast' })).toBeCloseTo(0.4, 10);
  });

  it('opus-5 fast prices', () => {
    expect(costOf(u({ input: M, output: M }), 'claude-opus-5', { speed: 'fast' })).toBeCloseTo(60, 10);
  });

  it('is ignored for models without fast pricing', () => {
    const d = costDetail(u({ input: M }), 'claude-sonnet-4-6', { speed: 'fast' });
    expect(d.fast).toBe(false);
    expect(d.costUsd).toBeCloseTo(3, 10);
  });

  it('standard speed is the normal price', () => {
    expect(costOf(u({ input: M }), 'claude-opus-4-8', { speed: 'standard' })).toBeCloseTo(5, 10);
  });
});

describe('Haiku 5.5 long-prompt tier', () => {
  it('uses base prices at or below 100k prompt tokens', () => {
    const d = costDetail(u({ input: 50_000, cacheRead: 50_000, output: 1000 }), 'claude-haiku-5-5');
    expect(d.tierAbove).toBeNull();
    expect(d.costUsd).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01 + 1000 * 0.5) / M, 12);
  });

  it('prices the whole request at the tier above 100k prompt tokens', () => {
    const d = costDetail(u({ input: 60_000, cacheRead: 40_000, cacheWrite5m: 1, output: 1000 }), 'claude-haiku-5-5');
    expect(d.tierAbove).toBe(100_000);
    expect(d.costUsd).toBeCloseTo((60_000 * 0.5 + 40_000 * 0.05 + 1 * 0.625 + 1000 * 2.5) / M, 12);
  });

  it('decides the tier per iteration when usage.iterations has several calls', () => {
    const it1 = u({ input: 60_000, output: 100 });
    const it2 = u({ input: 2_000, cacheRead: 60_000, output: 200 });
    const top = u({ input: 62_000, cacheRead: 60_000, output: 300, webSearch: 1 });
    expect(costDetail(top, 'claude-haiku-5-5').tierAbove).toBe(100_000);
    const d = costDetail(top, 'claude-haiku-5-5', { iterations: [it1, it2] });
    expect(d.tierAbove).toBeNull();
    expect(d.costUsd).toBeCloseTo((62_000 * 0.1 + 60_000 * 0.01 + 300 * 0.5) / M + 0.01, 12);
  });

  it('prices only the iterations that exceed the threshold at the tier', () => {
    const big = u({ input: 150_000, output: 100 });
    const small = u({ input: 1_000, output: 100 });
    const top = u({ input: 151_000, output: 200 });
    const d = costDetail(top, 'claude-haiku-5-5', { iterations: [big, small] });
    expect(d.tierAbove).toBe(100_000);
    expect(d.costUsd).toBeCloseTo((150_000 * 0.5 + 100 * 2.5 + 1_000 * 0.1 + 100 * 0.5) / M, 12);
  });

  it('uses the top-level usage when there is at most one iteration', () => {
    const top = u({ input: 60_000, cacheRead: 50_000, output: 10 });
    const one = costDetail(top, 'claude-haiku-5-5', { iterations: [top] });
    expect(one).toEqual(costDetail(top, 'claude-haiku-5-5'));
    expect(costDetail(top, 'claude-haiku-5-5', { iterations: [] })).toEqual(one);
  });

  it('output tokens do not count toward the threshold', () => {
    expect(costDetail(u({ input: 100_000, output: 500_000 }), 'claude-haiku-5-5').tierAbove).toBeNull();
  });
});

describe('inference_geo us surcharge', () => {
  it('applies 1.1x on 4.6+ models', () => {
    expect(costOf(u({ input: M }), 'claude-opus-4-6', { inferenceGeo: 'us' })).toBeCloseTo(5.5, 10);
    expect(costOf(u({ input: M }), 'claude-sonnet-5-5', { inferenceGeo: 'us' })).toBeCloseTo(2.2, 10);
  });

  it('does not apply to older models or other geos', () => {
    expect(costOf(u({ input: M }), 'claude-opus-4-5', { inferenceGeo: 'us' })).toBeCloseTo(5, 10);
    expect(costOf(u({ input: M }), 'claude-opus-4-6', { inferenceGeo: 'global' })).toBeCloseTo(5, 10);
    expect(costOf(u({ input: M }), 'claude-opus-4-6', { inferenceGeo: null })).toBeCloseTo(5, 10);
  });

  it('does not apply to web search fees', () => {
    expect(costOf(u({ webSearch: 3 }), 'claude-opus-4-6', { inferenceGeo: 'us' })).toBeCloseTo(0.03, 12);
  });
});

describe('web search', () => {
  it('costs $0.01 per request on top of tokens', () => {
    expect(costOf(u({ input: M, webSearch: 5 }), 'claude-sonnet-4-5')).toBeCloseTo(3.05, 10);
  });
});

describe('unpriced models', () => {
  it('flags unknown models and costs 0', () => {
    const d = costDetail(u({ input: M, output: M }), 'gpt-9-turbo');
    expect(d).toMatchObject({ costUsd: 0, priced: false, family: 'gpt-9-turbo' });
    expect(isPriced('gpt-9-turbo')).toBe(false);
    expect(priceFor('gpt-9-turbo')).toBeNull();
  });

  it('treats <synthetic> as unpriced', () => {
    expect(normalizeModel('<synthetic>')).toEqual({ id: '<synthetic>', family: '<synthetic>', priced: false });
    expect(costOf(u({ output: 100 }), '<synthetic>')).toBe(0);
  });

  it('does not match a key that is only a prefix within a segment', () => {
    expect(isPriced('claude-opus-45')).toBe(false);
    expect(isPriced('claude-sonnet')).toBe(false);
  });

  it('an unknown future minor version of a known family stays unpriced rather than mispriced', () => {
    // claude-opus-4-9 must not silently fall back to claude-opus-4 prices.
    expect(normalizeModel('claude-opus-4-9')).toEqual({ id: 'claude-opus-4-9', family: 'claude-opus-4-9', priced: false });
    expect(isPriced('claude-sonnet-5-7')).toBe(false);
    // A non-version suffix still matches its family.
    expect(normalizeModel('claude-sonnet-4-5-latest').family).toBe('claude-sonnet-4-5');
  });
});

describe('normalizeModel', () => {
  it.each([
    ['claude-opus-4-7', 'claude-opus-4-7'],
    ['Claude-Opus-4-7', 'claude-opus-4-7'],
    ['claude-opus-4-7[1m]', 'claude-opus-4-7'],
    ['claude-sonnet-4-6[1M]', 'claude-sonnet-4-6'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
    ['claude-opus-4-20250514', 'claude-opus-4'],
    ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet'],
    ['claude-3-7-sonnet-20250219', 'claude-3-7-sonnet'],
    ['claude-3-haiku-20240307', 'claude-3-haiku'],
    // Bedrock
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'claude-opus-4-1'],
    ['eu.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5'],
    ['apac.anthropic.claude-3-5-sonnet-20240620-v1:0', 'claude-3-5-sonnet'],
    ['global.anthropic.claude-opus-4-7-v1', 'claude-opus-4-7'],
    // Vertex
    ['claude-sonnet-4-5@20250929', 'claude-sonnet-4-5'],
    ['claude-opus-4-1@20250805', 'claude-opus-4-1'],
  ])('%s -> %s', (raw, family) => {
    const n = normalizeModel(raw);
    expect(n.family).toBe(family);
    expect(n.priced).toBe(true);
  });

  it('prefers the longest matching key', () => {
    expect(normalizeModel('claude-opus-4-5').family).toBe('claude-opus-4-5');
    expect(normalizeModel('claude-fable-5-1').family).toBe('claude-fable-5-1');
    expect(normalizeModel('claude-fable-5').family).toBe('claude-fable-5');
    expect(normalizeModel('claude-opus-5-5').family).toBe('claude-opus-5-5');
    expect(normalizeModel('claude-opus-5').family).toBe('claude-opus-5');
  });

  it('[1m] context costs the same as the base model', () => {
    const t = u({ input: 1234, output: 567 });
    expect(costOf(t, 'claude-opus-4-7[1m]')).toBe(costOf(t, 'claude-opus-4-7'));
  });

  it('cleanModelId lowercases and strips the context suffix only', () => {
    expect(cleanModelId(' Claude-Opus-4-7[1m] ')).toBe('claude-opus-4-7');
    expect(cleanModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
  });
});

describe('cacheSavings', () => {
  it('is cached tokens at input price minus actual cache cost', () => {
    // sonnet-4-6: 1M reads save 3 - 0.3 = 2.7; 100k 5m writes cost 0.075 extra
    const s = cacheSavings(u({ cacheRead: M, cacheWrite5m: 100_000 }), 'claude-sonnet-4-6');
    expect(s).toBeCloseTo(2.7 - 0.075, 10);
  });

  it('is negative when only writes happen', () => {
    expect(cacheSavings(u({ cacheWrite1h: M }), 'claude-sonnet-4-6')).toBeCloseTo(-3, 10);
  });

  it('is 0 for unpriced models and empty usage', () => {
    expect(cacheSavings(u({ cacheRead: M }), 'mystery-model')).toBe(0);
    expect(cacheSavings(emptyUsage(), 'claude-opus-4-7')).toBe(0);
  });

  it('respects fast mode', () => {
    // opus-4-8 fast: input 10, cacheRead 1 -> 9 saved per MTok
    expect(cacheSavings(u({ cacheRead: M }), 'claude-opus-4-8', { speed: 'fast' })).toBeCloseTo(9, 10);
  });
});

describe('tokensFromApiUsage', () => {
  it('maps the split cache_creation fields', () => {
    expect(
      tokensFromApiUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 70,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 30 },
        server_tool_use: { web_search_requests: 2 },
      }),
    ).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite5m: 40, cacheWrite1h: 30, webSearch: 2 });
  });

  it('treats unsplit cache creation as 5m writes', () => {
    expect(tokensFromApiUsage({ input_tokens: 1, cache_creation_input_tokens: 500 })).toMatchObject({ cacheWrite5m: 500, cacheWrite1h: 0 });
  });

  it('zeros missing, null, negative and non-finite values', () => {
    expect(tokensFromApiUsage({ input_tokens: null, output_tokens: -5, cache_read_input_tokens: Number.NaN })).toEqual(emptyUsage());
  });
});
