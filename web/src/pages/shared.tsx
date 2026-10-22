import { useMemo } from 'react';
import type { TimeseriesSeries } from '@ccu/shared';
import { agentKindLabel, modelLabel } from '../format';
import { agentKindColor, assignColors, modelColorMap } from '../palette';

/** Stable color + label lookups for a set of model series. */
export function useModelSeriesStyle(series: readonly TimeseriesSeries[] | undefined) {
  const keys = useMemo(() => (series ?? []).map((s) => s.key).join('|'), [series]);
  return useMemo(() => {
    const colors = modelColorMap(keys ? keys.split('|') : []);
    return {
      colorFor: (k: string) => colors.get(k) ?? 'var(--series-other)',
      labelFor: (k: string) => modelLabel(k),
    };
  }, [keys]);
}

/** Colors by sorted key, so a project keeps its color whatever its rank this period. */
export function useKeyedSeriesStyle(series: readonly TimeseriesSeries[] | undefined, label?: (k: string) => string) {
  const keys = useMemo(() => [...new Set((series ?? []).map((s) => s.key))].sort().join('|'), [series]);
  return useMemo(() => {
    const colors = assignColors(keys ? keys.split('|') : []);
    const labels = new Map((series ?? []).map((s) => [s.key, s.label ?? s.key]));
    return {
      colorFor: (k: string) => colors.get(k) ?? 'var(--series-other)',
      labelFor: (k: string) => label?.(k) ?? labels.get(k) ?? k,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
}

export const agentSeriesStyle = {
  colorFor: (k: string) => agentKindColor(k),
  labelFor: (k: string) => agentKindLabel(k),
};
