import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  /** One line under the title (units, scope). */
  subtitle?: ReactNode;
  /** Right-aligned header controls (a Segmented, a link). */
  actions?: ReactNode;
  /** Dims the body while a refetch is in flight (previous data stays visible). */
  refreshing?: boolean;
  /** Footer note, e.g. <CostNote />. */
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
  /** Optional id for in-page links / aria. */
  id?: string;
}

export function Card({ title, subtitle, actions, refreshing, footer, className, children, id }: CardProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={`card${className ? ' ' + className : ''}`} id={id} aria-labelledby={title ? headingId : undefined} aria-busy={refreshing || undefined}>
      {(title || actions) && (
        <header className="card-head">
          <div className="card-titles">
            {title && (
              <h2 className="card-title" id={headingId}>
                {title}
              </h2>
            )}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={`card-body${refreshing ? ' is-refreshing' : ''}`}>{children}</div>
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}
