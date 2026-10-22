import type { TimeseriesSeries } from '@ccu/shared';
import { MAX_SERIES, OTHER_COLOR, OTHER_KEY, seriesColor } from '../../palette';

export interface ProjectCost {
  project: string;
  costUsd: number;
}

/**
 * One color per project for the whole page (chart, table swatches, sparklines).
 * With more than `max` projects, the biggest `max - 1` by cost keep a slot and the
 * rest share "Other". Slots go out in key order, not rank order, so a project keeps
 * its color when the ranking shifts.
 */
export function projectColorMap(rows: readonly ProjectCost[], max = MAX_SERIES): Map<string, string> {
  const keep =
    rows.length <= max
      ? rows.map((r) => r.project)
      : [...rows].sort((a, b) => b.costUsd - a.costUsd || a.project.localeCompare(b.project)).slice(0, max - 1).map((r) => r.project);
  const out = new Map<string, string>();
  [...keep].sort().forEach((p, i) => out.set(p, seriesColor(i)));
  for (const r of rows) if (!out.has(r.project)) out.set(r.project, OTHER_COLOR);
  return out;
}

/** Sums every series whose project has no own color (or is unknown) into one "Other" series. */
export function foldUncolored(series: readonly TimeseriesSeries[], colors: ReadonlyMap<string, string>): TimeseriesSeries[] {
  const kept: TimeseriesSeries[] = [];
  const sums = new Map<number, number>();
  let folded = 0;
  for (const s of series) {
    const c = colors.get(s.key);
    if (c && c !== OTHER_COLOR) {
      kept.push(s);
      continue;
    }
    folded++;
    for (const [t, v] of s.points) sums.set(t, (sums.get(t) ?? 0) + v);
  }
  if (folded === 0) return kept;
  const points = [...sums.entries()].sort((a, b) => a[0] - b[0]);
  return [...kept, { key: OTHER_KEY, label: folded === 1 ? 'Other project' : `Other (${folded})`, points }];
}
