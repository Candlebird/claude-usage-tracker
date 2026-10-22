import { modelFamilyWord } from './format';

/**
 * Chart colors as CSS variable references, so light/dark swap in tokens.css.
 * Rules (dataviz skill): fixed slot order, never cycled; color follows the entity,
 * never its rank; a 9th series folds into "Other".
 */
export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const;
export const OTHER_COLOR = 'var(--series-other)';
export const OTHER_KEY = '__other__';
export const MAX_SERIES = SERIES.length;

export function seriesColor(slot: number): string {
  return slot >= 0 && slot < SERIES.length ? SERIES[slot]! : OTHER_COLOR;
}

/** Model families own fixed slots so a model keeps its color on every page. */
const MODEL_FAMILY_SLOT: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3, mythos: 6 };

/**
 * Model color: the family slot, with older versions of the same family taking
 * spare slots (4, 5, 7) in the order given by `allModels` (pass the full, stable
 * list of models on the page so colors don't move when filtering).
 */
export function modelColor(model: string, allModels: readonly string[] = []): string {
  return modelColorMap(allModels.includes(model) ? allModels : [...allModels, model]).get(model)!;
}

/** Colors for a whole set of models at once (newest version of each family gets the family slot). */
export function modelColorMap(models: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = [...new Set(models)].sort().reverse(); // newest version first within a family
  const claimed = new Set<string>();
  const extras: string[] = [];
  for (const m of sorted) {
    const fam = modelFamilyWord(m);
    if (fam && fam in MODEL_FAMILY_SLOT && !claimed.has(fam)) {
      claimed.add(fam);
      out.set(m, seriesColor(MODEL_FAMILY_SLOT[fam]!));
    } else {
      extras.push(m);
    }
  }
  const spare = [4, 5, 7];
  extras.sort().forEach((m, i) => out.set(m, i < spare.length ? seriesColor(spare[i]!) : OTHER_COLOR));
  return out;
}

const AGENT_SLOT: Record<string, number> = { main: 0, subagent: 1, workflow: 2 };
export function agentKindColor(kind: string): string {
  return seriesColor(AGENT_SLOT[kind] ?? -1);
}

const TOKEN_SLOT: Record<string, number> = { input: 0, output: 1, cacheRead: 2, cacheWrite5m: 3, cacheWrite1h: 4 };
export function tokenTypeColor(type: string): string {
  return seriesColor(TOKEN_SLOT[type] ?? -1);
}

/**
 * Assigns slots to keys in the given (stable) order. Keys past the 8th share the
 * "Other" color; callers should fold them with `foldOther` before charting.
 */
export function assignColors(keys: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  keys.forEach((k, i) => m.set(k, k === OTHER_KEY ? OTHER_COLOR : seriesColor(i)));
  return m;
}

/** Status palette for limit meters: reserved, never used for series. */
export type Status = 'ok' | 'warning' | 'serious' | 'critical';
export function statusFor(utilization: number, thresholds: readonly [number, number] = [70, 90]): Status {
  if (utilization >= 100) return 'critical';
  if (utilization >= thresholds[1]) return 'serious';
  if (utilization >= thresholds[0]) return 'warning';
  return 'ok';
}
export const STATUS_COLOR: Record<Status, string> = {
  ok: 'var(--accent)',
  warning: 'var(--warning)',
  serious: 'var(--serious)',
  critical: 'var(--critical)',
};
export const STATUS_LABEL: Record<Status, string> = {
  ok: 'On track',
  warning: 'Getting close',
  serious: 'Near limit',
  critical: 'At limit',
};
