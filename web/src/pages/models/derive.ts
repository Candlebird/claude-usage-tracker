import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  TOKEN_TYPES,
  type ModelRow,
  type TimeseriesSeries,
  type TokenType,
} from '@ccu/shared';

export type TypeTotals = Record<TokenType, number>;

export function emptyTypeTotals(): TypeTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

function isTokenType(k: string): k is TokenType {
  return (TOKEN_TYPES as readonly string[]).includes(k);
}

/** Sums each `group=type` series over the whole range. Unknown keys are ignored. */
export function typeTotals(series: readonly TimeseriesSeries[]): TypeTotals {
  const out = emptyTypeTotals();
  for (const s of series) {
    if (!isTokenType(s.key)) continue;
    for (const [, v] of s.points) out[s.key] += v;
  }
  return out;
}

/** Type series in the fixed TOKEN_TYPES order, so stacks read input -> output -> cache. */
export function orderByType(series: readonly TimeseriesSeries[]): TimeseriesSeries[] {
  const rank = (k: string) => (isTokenType(k) ? TOKEN_TYPES.indexOf(k) : TOKEN_TYPES.length);
  return [...series].sort((a, b) => rank(a.key) - rank(b.key));
}

export function pickTypes(series: readonly TimeseriesSeries[], keys: readonly TokenType[]): TimeseriesSeries[] {
  return orderByType(series.filter((s) => (keys as readonly string[]).includes(s.key)));
}

/** cacheRead / (input + cacheRead + writes); null when nothing was sent. */
export function hitRate(t: Pick<TypeTotals, 'input' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h'>): number | null {
  const denom = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return denom > 0 ? t.cacheRead / denom : null;
}

export type RatePoint = { t: number; rate: number | null };

/** Per-bucket cache hit rate (0-1) from `group=type, metric=tokens` series. Empty buckets are null (a gap, not 0%). */
export function hitRateSeries(series: readonly TimeseriesSeries[]): RatePoint[] {
  const byT = new Map<number, TypeTotals>();
  for (const s of series) {
    if (!isTokenType(s.key)) continue;
    for (const [t, v] of s.points) {
      let row = byT.get(t);
      if (!row) byT.set(t, (row = emptyTypeTotals()));
      row[s.key] += v;
    }
  }
  return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, row]) => ({ t, rate: hitRate(row) }));
}

export interface RateStats {
  min: RatePoint | null;
  max: RatePoint | null;
  /** Buckets with traffic. */
  active: number;
}

export function rateStats(points: readonly RatePoint[]): RateStats {
  let min: RatePoint | null = null;
  let max: RatePoint | null = null;
  let active = 0;
  for (const p of points) {
    if (p.rate == null) continue;
    active++;
    if (!min || p.rate < min.rate!) min = p;
    if (!max || p.rate > max.rate!) max = p;
  }
  return { min, max, active };
}

export interface ModelTotals extends TypeTotals {
  costUsd: number;
  totalTokens: number;
  requests: number;
  cacheSavingsUsd: number;
  cacheHitRate: number | null;
  unpriced: string[];
}

/** Range totals from the per-model rows (the authoritative per-model rollup). */
export function totalsFromModels(rows: readonly ModelRow[]): ModelTotals {
  const t: ModelTotals = { ...emptyTypeTotals(), costUsd: 0, totalTokens: 0, requests: 0, cacheSavingsUsd: 0, cacheHitRate: null, unpriced: [] };
  for (const r of rows) {
    for (const k of TOKEN_TYPES) t[k] += r[k];
    t.costUsd += r.costUsd;
    t.totalTokens += r.totalTokens;
    t.requests += r.requests;
    t.cacheSavingsUsd += r.cacheSavingsUsd;
    if (!r.priced) t.unpriced.push(r.model);
  }
  t.cacheHitRate = hitRate(t);
  return t;
}

export interface WriteSplit {
  tokens5m: number;
  tokens1h: number;
  /** 0-1 share of write tokens that used the 1-hour TTL; null with no writes. */
  share1h: number | null;
  cost5m: number;
  cost1h: number;
  /** Extra API-equivalent cost of the 1-hour TTL versus writing the same tokens at the 5-minute rate. */
  premium1h: number;
}

/** 5-minute vs 1-hour cache writes. `cost` is the `metric=cost` type totals; pass null when unavailable. */
export function writeSplit(tokens: TypeTotals, cost: TypeTotals | null): WriteSplit {
  const all = tokens.cacheWrite5m + tokens.cacheWrite1h;
  const cost1h = cost?.cacheWrite1h ?? 0;
  return {
    tokens5m: tokens.cacheWrite5m,
    tokens1h: tokens.cacheWrite1h,
    share1h: all > 0 ? tokens.cacheWrite1h / all : null,
    cost5m: cost?.cacheWrite5m ?? 0,
    cost1h,
    premium1h: cost1h * (1 - CACHE_WRITE_5M_MULTIPLIER / CACHE_WRITE_1H_MULTIPLIER),
  };
}

export interface MixPart {
  type: TokenType;
  value: number;
  /** 0-1 */
  share: number;
}

/** Token-type composition (fixed order), shares of the sum. */
export function mixParts(t: TypeTotals): MixPart[] {
  const sum = TOKEN_TYPES.reduce((n, k) => n + t[k], 0);
  return TOKEN_TYPES.map((type) => ({ type, value: t[type], share: sum > 0 ? t[type] / sum : 0 }));
}
