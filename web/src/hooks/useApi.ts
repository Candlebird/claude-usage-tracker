import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { isUnauthorized, type ApiClient } from '../api';
import { useApiContext } from '../state/api';
import { useControls } from '../state/controls';

export interface ApiState<T> {
  data: T | undefined;
  error: Error | null;
  /** First load: nothing to show yet. */
  loading: boolean;
  /** A refetch is in flight while the previous data is still shown. */
  refreshing: boolean;
  reload(): void;
}

export type Fetcher<T> = (client: ApiClient, signal: AbortSignal) => Promise<T>;

export interface UseApiOptions {
  /**
   * Auto-refetch cadence. `'data'` (default): every aggregate tick (5 min, manual refresh,
   * tab re-shown), for range/rollup queries. `'live'`: every 60 s tick, for cheap
   * live/health endpoints. `false`: only when deps change or `reload()` is called.
   */
  auto?: 'data' | 'live' | false;
  /** Skip fetching while false. */
  enabled?: boolean;
}

/**
 * Runs `fetcher` when `deps` change and on the auto-refresh clock picked by `opts.auto`.
 * Keeps the previous data during refetches (render it dimmed, never a skeleton),
 * aborts superseded requests, and sends a 401 back to the connect screen.
 */
export function useApi<T>(fetcher: Fetcher<T>, deps: DependencyList, opts: UseApiOptions = {}): ApiState<T> {
  const { client, onUnauthorized } = useApiContext();
  const { tick, dataTick } = useControls();
  const [manual, setManual] = useState(0);
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; pending: boolean }>({
    data: undefined,
    error: null,
    pending: opts.enabled ?? true,
  });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const auto = opts.auto ?? 'data';
  const autoTick = auto === 'live' ? tick : auto === 'data' ? dataTick : 0;
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.pending ? { ...s, pending: false } : s));
      return;
    }
    const ac = new AbortController();
    setState((s) => (s.pending ? s : { ...s, pending: true }));
    fetcherRef.current(client, ac.signal).then(
      (data) => {
        if (!ac.signal.aborted) setState({ data, error: null, pending: false });
      },
      (e: unknown) => {
        if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return;
        if (isUnauthorized(e)) unauthorizedRef.current();
        setState((s) => ({ data: s.data, error: e instanceof Error ? e : new Error(String(e)), pending: false }));
      },
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, manual, autoTick, ...deps]);

  const reload = useCallback(() => setManual((n) => n + 1), []);
  return {
    data: state.data,
    error: state.error,
    loading: state.pending && state.data === undefined,
    refreshing: state.pending && state.data !== undefined,
    reload,
  };
}
