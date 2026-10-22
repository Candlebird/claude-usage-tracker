import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export function EmptyState({ title = 'Nothing here yet', children, icon = 'inbox', action }: { title?: string; children?: ReactNode; icon?: IconName; action?: ReactNode }) {
  return (
    <div className="state state-empty" role="status">
      <Icon name={icon} size={24} />
      <p className="state-title">{title}</p>
      {children && <p className="state-body">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this' }: { error: Error | string; onRetry?: () => void; title?: string }) {
  const msg = typeof error === 'string' ? error : error.message;
  return (
    <div className="state state-error" role="alert">
      <Icon name="alert" size={24} />
      <p className="state-title">{title}</p>
      <p className="state-body">{msg}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="refresh" size={14} /> Try again
        </button>
      )}
    </div>
  );
}

/** Placeholder block for first load only; refetches dim the old content instead. */
export function Skeleton({ height = 16, width = '100%', lines = 1, style }: { height?: number; width?: number | string; lines?: number; style?: CSSProperties }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: i === lines - 1 && lines > 1 ? '60%' : width, ...style }} />
      ))}
    </div>
  );
}
