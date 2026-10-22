import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { nowSeconds, type TimeRange } from '@ccu/shared';
import { bucketFor, isRangePreset, resolveRange, type RangePreset, type RangeState } from './range';

export const REFRESH_MS = 60_000;
/**
 * Aggregate queries (ranges, summaries, rollups) refetch at most this often. Sync uploads
 * every 5 minutes, so faster refetches return the same rows while still counting
 * against D1's free 5M rows-read/day; live widgets keep the 60 s cadence.
 */
export const AGGREGATE_REFRESH_MS = 300_000;
const PRESET_KEY = 'ccu.range';

export interface Controls {
  preset: RangePreset;
  custom: TimeRange | null;
  /** Concrete range for queries, recomputed on every aggregate tick (from `dataNow`). */
  range: TimeRange;
  bucket: 'hour' | 'day';
  tz: string;
  /** Live clock: increments every 60 s (while visible) and on manual refresh. */
  tick: number;
  /** Unix seconds at the last live tick; use it for "x ago" labels. */
  now: number;
  /** Aggregate clock: increments every AGGREGATE_REFRESH_MS, on manual refresh and when the tab becomes visible again. */
  dataTick: number;
  /** Unix seconds at the last aggregate tick; use it to build query ranges. */
  dataNow: number;
  setPreset(p: RangePreset): void;
  setCustom(r: TimeRange): void;
  refresh(): void;
}

const Ctx = createContext<Controls | null>(null);

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function loadPreset(): RangePreset {
  try {
    const v = localStorage.getItem(PRESET_KEY);
    return isRangePreset(v) && v !== 'custom' ? v : '7d';
  } catch {
    return '7d';
  }
}

/** Calls `fn` every `ms` while the page is visible, and `onResume` (default `fn`) when it becomes visible again. */
export function useVisibleInterval(fn: () => void, ms: number, onResume?: () => void): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const resumeRef = useRef(onResume);
  resumeRef.current = onResume;
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id == null) id = setInterval(() => fnRef.current(), ms);
    };
    const stop = () => {
      if (id != null) clearInterval(id);
      id = null;
    };
    const onVis = () => {
      if (document.hidden) stop();
      else {
        (resumeRef.current ?? fnRef.current)();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms]);
}

export function ControlsProvider({
  children,
  now: nowFn = nowSeconds,
  refreshMs = REFRESH_MS,
  aggregateMs = AGGREGATE_REFRESH_MS,
}: {
  children: ReactNode;
  now?: () => number;
  refreshMs?: number;
  aggregateMs?: number;
}) {
  const [state, setState] = useState<RangeState>(() => ({ preset: loadPreset(), custom: null }));
  const [clock, setClock] = useState(() => {
    const t = nowFn();
    return { tick: 0, now: t, dataTick: 0, dataNow: t };
  });
  const tz = useMemo(browserTimeZone, []);

  const refresh = useCallback(() => setClock((c) => nextClock(c, nowFn(), true, 0)), [nowFn]);
  const autoTick = useCallback(() => setClock((c) => nextClock(c, nowFn(), false, aggregateMs / 1000 - refreshMs / 2000)), [nowFn, aggregateMs, refreshMs]);
  useVisibleInterval(autoTick, refreshMs, refresh);

  const setPreset = useCallback(
    (preset: RangePreset) => {
      setState((s) => ({ preset, custom: preset === 'custom' ? (s.custom ?? resolveRange(s, nowFn())) : s.custom }));
      if (preset === 'custom') return;
      try {
        localStorage.setItem(PRESET_KEY, preset);
      } catch {
        /* remembered for this page view only */
      }
    },
    [nowFn],
  );
  const setCustom = useCallback((custom: TimeRange) => setState({ preset: 'custom', custom }), []);

  const value = useMemo<Controls>(() => {
    const range = resolveRange(state, clock.dataNow);
    return { ...state, range, bucket: bucketFor(range), tz, ...clock, setPreset, setCustom, refresh };
  }, [state, clock, tz, setPreset, setCustom, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export interface Clock {
  tick: number;
  now: number;
  dataTick: number;
  dataNow: number;
}

/**
 * Advances the live clock; advances the aggregate clock too when `force`d or when at
 * least `minDataAgeSec` has passed since it last moved (slack absorbs timer jitter).
 */
export function nextClock(c: Clock, now: number, force: boolean, minDataAgeSec: number): Clock {
  const data = force || now - c.dataNow >= minDataAgeSec;
  return { tick: c.tick + 1, now, dataTick: data ? c.dataTick + 1 : c.dataTick, dataNow: data ? now : c.dataNow };
}

export function useControls(): Controls {
  const v = useContext(Ctx);
  if (!v) throw new Error('useControls must be used inside <ControlsProvider>');
  return v;
}
