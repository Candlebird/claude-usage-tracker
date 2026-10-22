import type { ReactNode } from 'react';
import type { ApiState } from '../hooks/useApi';
import { EmptyState, ErrorState, Skeleton } from './States';

export interface AsyncViewProps<T> {
  state: ApiState<T>;
  /** Returns true when loaded data has nothing to show. */
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  /** Skeleton height for the first load. */
  skeletonHeight?: number;
  children: (data: T, refreshing: boolean) => ReactNode;
}

/**
 * Loading -> skeleton, error with no data -> ErrorState, empty -> EmptyState,
 * otherwise children. A failed refetch keeps showing the last good data.
 */
export function AsyncView<T>({ state, isEmpty, empty, skeletonHeight = 160, children }: AsyncViewProps<T>) {
  if (state.data === undefined) {
    if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
    return <Skeleton height={skeletonHeight} />;
  }
  if (isEmpty?.(state.data)) return <>{empty ?? <EmptyState />}</>;
  return <>{children(state.data, state.refreshing)}</>;
}
