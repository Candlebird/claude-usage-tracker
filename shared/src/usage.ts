import type { UsageTokens, UsageTotals } from './types.js';

export function emptyUsage(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
}

export function emptyTotals(): UsageTotals {
  return { ...emptyUsage(), totalTokens: 0, requests: 0, costUsd: 0 };
}

/** Sum of every token category (webSearch is a request count, so it is excluded). */
export function totalTokens(u: UsageTokens): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** Adds `b` into `a` in place and returns `a`. */
export function addUsage<T extends UsageTokens>(a: T, b: UsageTokens): T {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
  a.webSearch += b.webSearch;
  return a;
}

/** cacheRead / (input + cacheRead + cacheWrite); null when there is no input at all. */
export function cacheHitRate(u: Pick<UsageTokens, 'input' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h'>): number | null {
  const denom = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  return denom > 0 ? u.cacheRead / denom : null;
}

/** Raw `message.usage` as written by the Anthropic API / Claude Code transcripts (loose). */
export interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
  speed?: string | null;
  inference_geo?: string | null;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Converts API usage to UsageTokens. Without a `cache_creation` split, all of
 * `cache_creation_input_tokens` counts as 5-minute writes (older Claude Code versions).
 */
export function tokensFromApiUsage(u: ApiUsage): UsageTokens {
  const split = u.cache_creation;
  const hasSplit = split != null && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m: hasSplit ? n(split.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens),
    cacheWrite1h: hasSplit ? n(split.ephemeral_1h_input_tokens) : 0,
    webSearch: n(u.server_tool_use?.web_search_requests),
  };
}
