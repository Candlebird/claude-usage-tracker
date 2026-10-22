// Shared aggregation pieces for the read routes: SQL sum columns, row -> totals,
// and per-model KPI rollups priced with the shared pricing module.
import {
  addUsage,
  cacheHitRate,
  cacheSavings,
  emptyTotals,
  isPriced,
  SYNTHETIC_MODEL,
  totalTokens,
  type PeriodKpis,
  type UsageTotals,
} from '@ccu/shared';

/** Sum columns over usage_hourly (optionally table-qualified). TOTAL() never returns NULL. */
export function sumColumns(t = ''): string {
  const p = t ? `${t}.` : '';
  return [
    `TOTAL(${p}input) AS input`,
    `TOTAL(${p}output) AS output`,
    `TOTAL(${p}cache_read) AS cacheRead`,
    `TOTAL(${p}cache_write_5m) AS cacheWrite5m`,
    `TOTAL(${p}cache_write_1h) AS cacheWrite1h`,
    `TOTAL(${p}web_search) AS webSearch`,
    `TOTAL(${p}requests) AS requests`,
    `TOTAL(${p}cost_usd) AS costUsd`,
  ].join(', ');
}

/** Shape of a row selected with `sumColumns()`. */
export interface SumRow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  requests: number;
  costUsd: number;
}

export function totalsOf(r: SumRow): UsageTotals {
  const t: UsageTotals = {
    input: r.input ?? 0,
    output: r.output ?? 0,
    cacheRead: r.cacheRead ?? 0,
    cacheWrite5m: r.cacheWrite5m ?? 0,
    cacheWrite1h: r.cacheWrite1h ?? 0,
    webSearch: r.webSearch ?? 0,
    totalTokens: 0,
    requests: r.requests ?? 0,
    costUsd: r.costUsd ?? 0,
  };
  t.totalTokens = totalTokens(t);
  return t;
}

/** Adds `b` into `a` (tokens, requests, cost) and refreshes totalTokens. */
export function addTotals<T extends UsageTotals>(a: T, b: UsageTotals | SumRow): T {
  addUsage(a, b);
  a.requests += b.requests;
  a.costUsd += b.costUsd;
  a.totalTokens = totalTokens(a);
  return a;
}

/** Accumulates totals per model so cache savings can be priced per model. */
export class ModelRollup {
  readonly byModel = new Map<string, UsageTotals>();
  readonly sessions = new Set<string>();

  add(model: string, row: UsageTotals | SumRow, sessionId?: string): void {
    let t = this.byModel.get(model);
    if (!t) this.byModel.set(model, (t = emptyTotals()));
    addTotals(t, row);
    if (sessionId) this.sessions.add(sessionId);
  }

  totals(): UsageTotals {
    const out = emptyTotals();
    for (const t of this.byModel.values()) addTotals(out, t);
    return out;
  }

  savings(): number {
    let s = 0;
    for (const [model, t] of this.byModel) s += cacheSavings(t, model);
    return s;
  }

  kpis(): PeriodKpis {
    const t = this.totals();
    return { ...t, sessions: this.sessions.size, cacheHitRate: cacheHitRate(t), cacheSavingsUsd: round6(this.savings()) };
  }
}

/** Model ids with no price (the synthetic placeholder model is not a pricing gap). */
export function unpricedOf(models: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const m of models) if (m && m !== SYNTHETIC_MODEL && !isPriced(m)) out.add(m);
  return [...out].sort();
}

/** Trims float noise from summed costs. */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export function parseStringArray(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
