import type { TimeseriesSeries } from '@ccu/shared';
import { OTHER_COLOR, OTHER_KEY } from '../../palette';

export interface ShareInput {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface Share extends ShareInput {
  /** 0-1 of the total. */
  share: number;
}

/**
 * Positive parts sorted largest first, with their share of the total. Parts past
 * `max` are summed into one "Other" part so the bar never needs a ninth hue.
 */
export function toShares(parts: readonly ShareInput[], max = 8): Share[] {
  const pos = parts.filter((p) => Number.isFinite(p.value) && p.value > 0).sort((a, b) => b.value - a.value);
  const total = pos.reduce((n, p) => n + p.value, 0);
  if (total <= 0) return [];
  let kept: ShareInput[] = pos;
  if (pos.length > max) {
    const rest = pos.slice(max - 1);
    kept = [...pos.slice(0, max - 1), { key: OTHER_KEY, label: `Other (${rest.length})`, value: rest.reduce((n, p) => n + p.value, 0), color: OTHER_COLOR }];
  }
  return kept.map((p) => ({ ...p, share: p.value / total }));
}

/** Total of each series over all its points, in input order. */
export function seriesTotals(series: readonly TimeseriesSeries[]): { key: string; label?: string; total: number }[] {
  return series.map((s) => ({ key: s.key, label: s.label, total: s.points.reduce((n, [, v]) => n + v, 0) }));
}
