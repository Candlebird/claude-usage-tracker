import type { Speed, UsageTokens } from './types.js';

/** USD per million tokens. */
export interface PriceSet {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Applies to a whole request when its prompt (input + cacheRead + cache writes) exceeds the threshold. */
export interface PriceTier extends PriceSet {
  abovePromptTokens: number;
}

export interface ModelPrice extends PriceSet {
  /** Fast-mode input/output; cache prices scale from fast input with the model's multipliers. */
  fast?: { input: number; output: number };
  tiers?: PriceTier[];
  /** `inference_geo: "us"` costs 1.1x on Claude 4.6+ models. */
  usGeoSurcharge?: boolean;
  /** Not on the fetched pricing page; recalled historical list price. */
  historical?: boolean;
}

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const INFERENCE_GEO_US_MULTIPLIER = 1.1;
export const WEB_SEARCH_PER_REQUEST_USD = 0.01;

function price(input: number, output: number, cacheRead: number, extra: Partial<ModelPrice> = {}): ModelPrice {
  return {
    input,
    output,
    cacheRead,
    cacheWrite5m: input * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1h: input * CACHE_WRITE_1H_MULTIPLIER,
    ...extra,
  };
}

function tier(abovePromptTokens: number, input: number, output: number, cacheRead: number): PriceTier {
  return {
    abovePromptTokens,
    input,
    output,
    cacheRead,
    cacheWrite5m: input * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1h: input * CACHE_WRITE_1H_MULTIPLIER,
  };
}

const geo = { usGeoSurcharge: true } as const;

export const PRICING = {
  asOf: '2026-10-22',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  unit: 'USD per million tokens',
  webSearchPerRequest: WEB_SEARCH_PER_REQUEST_USD,
  /** Keyed by normalized model-id prefix. Claude 3.x keys use the old `claude-3-5-sonnet` order. */
  models: {
    'claude-fable-5-1': price(10, 50, 0.25, geo),
    'claude-mythos-5-1': price(10, 50, 0.25, geo),
    'claude-fable-5': price(10, 50, 1.0, geo),
    'claude-mythos-5': price(10, 50, 1.0, geo),
    'claude-opus-5-5': price(4, 20, 0.2, { ...geo, fast: { input: 8, output: 40 } }),
    'claude-opus-5': price(5, 25, 0.5, { ...geo, fast: { input: 10, output: 50 } }),
    'claude-opus-4-8': price(5, 25, 0.5, { ...geo, fast: { input: 10, output: 50 } }),
    'claude-opus-4-7': price(5, 25, 0.5, geo),
    'claude-opus-4-6': price(5, 25, 0.5, geo),
    'claude-opus-4-5': price(5, 25, 0.5),
    'claude-opus-4-1': price(15, 75, 1.5),
    'claude-opus-4': price(15, 75, 1.5),
    'claude-sonnet-5-5': price(2, 10, 0.1, geo),
    'claude-sonnet-5': price(2, 10, 0.2, geo),
    'claude-sonnet-4-6': price(3, 15, 0.3, geo),
    'claude-sonnet-4-5': price(3, 15, 0.3),
    'claude-sonnet-4': price(3, 15, 0.3),
    'claude-haiku-5-5': price(0.1, 0.5, 0.01, { ...geo, tiers: [tier(100_000, 0.5, 2.5, 0.05)] }),
    'claude-haiku-4-5': price(1, 5, 0.1),
    // Recalled fallbacks, not on the fetched page.
    'claude-3-7-sonnet': price(3, 15, 0.3, { historical: true }),
    'claude-3-5-sonnet': price(3, 15, 0.3, { historical: true }),
    'claude-3-5-haiku': price(0.8, 4, 0.08, { historical: true }),
    'claude-3-opus': price(15, 75, 1.5, { historical: true }),
    'claude-3-haiku': price(0.25, 1.25, 0.03, { historical: true }),
  } as Record<string, ModelPrice>,
} as const;

const KEYS_LONGEST_FIRST = Object.keys(PRICING.models).sort((a, b) => b.length - a.length);

export const SYNTHETIC_MODEL = '<synthetic>';

export interface NormalizedModel {
  /** Cleaned id: lowercase, no `[1m]`, no provider prefix/suffix, no date. */
  id: string;
  /** Matched price-table key, or the cleaned id when nothing matched. */
  family: string;
  priced: boolean;
}

/** Strips a `[1m]`-style context suffix and lowercases; the form stored as `model` in buckets. */
export function cleanModelId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
}

export function normalizeModel(raw: string): NormalizedModel {
  let id = cleanModelId(raw);
  if (id === SYNTHETIC_MODEL) return { id, family: id, priced: false };
  id = id
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/@.*$/, '')
    .replace(/-20\d{6}$/, '');
  // Longest key matching at a `-` boundary. A digit right after the boundary is an
  // unknown version (claude-opus-4-9 is not claude-opus-4), so it stays unpriced and gets flagged.
  const key = KEYS_LONGEST_FIRST.find((k) => id === k || (id.startsWith(k + '-') && !/\d/.test(id.charAt(k.length + 1))));
  return key ? { id, family: key, priced: true } : { id, family: id, priced: false };
}

export function priceFor(model: string): ModelPrice | null {
  const { family, priced } = normalizeModel(model);
  return priced ? PRICING.models[family]! : null;
}

export interface CostOptions {
  speed?: Speed | string | null;
  /** `usage.inference_geo`; only "us" changes the price. */
  inferenceGeo?: string | null;
  /**
   * Per-iteration tokens from `usage.iterations`. With more than one, length tiers are
   * decided and priced per iteration (each is its own API call), and the top-level
   * token counts are used only for web search.
   */
  iterations?: readonly UsageTokens[] | null;
}

export interface CostDetail {
  costUsd: number;
  priced: boolean;
  family: string;
  /** The highest tier threshold applied, if any (Haiku 5.5 long prompts; per iteration when given). */
  tierAbove: number | null;
  fast: boolean;
}

/** Effective per-MTok prices for one request after fast mode and length tiers. */
export function effectivePrices(p: ModelPrice, u: UsageTokens, opts: CostOptions = {}): { prices: PriceSet; tierAbove: number | null; fast: boolean } {
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const t = p.tiers?.filter((x) => prompt > x.abovePromptTokens).sort((a, b) => b.abovePromptTokens - a.abovePromptTokens)[0];
  let prices: PriceSet = t ?? p;
  const fast = opts.speed === 'fast' && p.fast != null;
  if (fast) {
    const scale = p.fast!.input / p.input;
    prices = {
      input: p.fast!.input,
      output: p.fast!.output,
      cacheRead: prices.cacheRead * scale,
      cacheWrite5m: p.fast!.input * CACHE_WRITE_5M_MULTIPLIER,
      cacheWrite1h: p.fast!.input * CACHE_WRITE_1H_MULTIPLIER,
    };
  }
  return { prices, tierAbove: t?.abovePromptTokens ?? null, fast };
}

/**
 * Prices ONE request (tiers depend on per-request prompt size, so price before summing).
 * Unpriced models cost 0 with `priced: false`.
 */
export function costDetail(u: UsageTokens, model: string, opts: CostOptions = {}): CostDetail {
  const norm = normalizeModel(model);
  if (!norm.priced) return { costUsd: 0, priced: false, family: norm.family, tierAbove: null, fast: false };
  const p = PRICING.models[norm.family]!;
  const geoMul = opts.inferenceGeo === 'us' && p.usGeoSurcharge ? INFERENCE_GEO_US_MULTIPLIER : 1;
  const calls = opts.iterations && opts.iterations.length > 1 ? opts.iterations : [u];
  let tokenCost = 0;
  let tierAbove: number | null = null;
  let fast = false;
  for (const c of calls) {
    const e = effectivePrices(p, c, opts);
    tokenCost += tokenCostUsd(c, e.prices);
    if (e.tierAbove != null) tierAbove = Math.max(tierAbove ?? 0, e.tierAbove);
    fast = e.fast;
  }
  const costUsd = tokenCost * geoMul + u.webSearch * WEB_SEARCH_PER_REQUEST_USD;
  return { costUsd, priced: true, family: norm.family, tierAbove, fast };
}

function tokenCostUsd(u: UsageTokens, prices: PriceSet): number {
  return (
    (u.input * prices.input +
      u.output * prices.output +
      u.cacheRead * prices.cacheRead +
      u.cacheWrite5m * prices.cacheWrite5m +
      u.cacheWrite1h * prices.cacheWrite1h) /
    1e6
  );
}

/** API-equivalent USD for one request; 0 for unpriced models (use costDetail/isPriced to flag). */
export function costOf(u: UsageTokens, model: string, opts: CostOptions = {}): number {
  return costDetail(u, model, opts).costUsd;
}

export function isPriced(model: string): boolean {
  return normalizeModel(model).priced;
}

/**
 * USD saved by caching: what the cached tokens would have cost as plain input,
 * minus what the cache reads and writes actually cost. Negative when writes outweigh reads.
 * Works on single requests or sums (ignores tiers for sums; fine as an estimate).
 */
export function cacheSavings(u: UsageTokens, model: string, opts: CostOptions = {}): number {
  const p = priceFor(model);
  if (!p) return 0;
  const { prices } = effectivePrices(p, u, opts);
  const cached = u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const asInput = cached * prices.input;
  const actual = u.cacheRead * prices.cacheRead + u.cacheWrite5m * prices.cacheWrite5m + u.cacheWrite1h * prices.cacheWrite1h;
  return (asInput - actual) / 1e6;
}
