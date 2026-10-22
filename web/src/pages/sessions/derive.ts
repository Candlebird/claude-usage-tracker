import type { UsageTotals } from '@ccu/shared';
import { tokenTypeColor } from '../../palette';
import { tokenTypeLabel } from '../../format';
import type { ShareInput } from './shares';

type CacheFields = Pick<UsageTotals, 'input' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h'>;

/** Share of prompt tokens served from cache; null when there were no prompt tokens. */
export function cacheHitRate(t: CacheFields): number | null {
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return prompt > 0 ? t.cacheRead / prompt : null;
}

/** Sums the cache fields over rows, for an aggregate hit rate weighted by tokens. */
export function sumCacheFields(rows: readonly CacheFields[]): CacheFields {
  return rows.reduce(
    (a, r) => ({ input: a.input + r.input, cacheRead: a.cacheRead + r.cacheRead, cacheWrite5m: a.cacheWrite5m + r.cacheWrite5m, cacheWrite1h: a.cacheWrite1h + r.cacheWrite1h }),
    { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  );
}

const TOKEN_TYPES = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

/** Token counts by type, colored by the fixed token-type slots. */
export function tokenParts(t: UsageTotals): ShareInput[] {
  return TOKEN_TYPES.map((k) => ({ key: k, label: tokenTypeLabel(k), value: t[k], color: tokenTypeColor(k) }));
}

export type OverheadView =
  | { kind: 'missing'; transcriptUsd: number }
  | { kind: 'extra' | 'none' | 'under'; transcriptUsd: number; costStateUsd: number; diffUsd: number; /** diff as a share of the cost-state total */ share: number | null };

/**
 * Compares the transcript-derived cost with the session's cost-state total.
 * `extra`: work the transcripts never show (titles, classifiers, compaction).
 * `under`: the cost-state total is lower, e.g. it was written before the session ended.
 */
export function overheadView(s: { costUsd: number; costStateUsd: number | null }, epsilon = 0.005): OverheadView {
  if (s.costStateUsd == null) return { kind: 'missing', transcriptUsd: s.costUsd };
  const diff = s.costStateUsd - s.costUsd;
  const kind = Math.abs(diff) < epsilon ? 'none' : diff > 0 ? 'extra' : 'under';
  return { kind, transcriptUsd: s.costUsd, costStateUsd: s.costStateUsd, diffUsd: diff, share: s.costStateUsd > 0 ? diff / s.costStateUsd : null };
}
