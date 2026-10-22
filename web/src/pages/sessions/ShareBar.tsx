import { useState } from 'react';
import { fmtRatio } from '../../format';
import { toShares, type ShareInput } from './shares';
import './sessions.css';

export interface ShareBarProps {
  parts: readonly ShareInput[];
  format: (v: number) => string;
  /** Accessible name for the bar, e.g. "Cost by model". */
  label: string;
  max?: number;
}

/**
 * A single 100% bar with a value list beneath it. The list is the numeric
 * alternative to the bar; hovering either highlights the same part.
 */
export function ShareBar({ parts, format, label, max }: ShareBarProps) {
  const [hot, setHot] = useState<string | null>(null);
  const shares = toShares(parts, max);
  if (shares.length === 0) return <p className="muted small">Nothing recorded.</p>;
  return (
    <figure className="sharebar" aria-label={label}>
      <div className="sharebar-track" role="img" aria-label={`${label}: ${shares.map((s) => `${s.label} ${fmtRatio(s.share)}`).join(', ')}`}>
        {shares.map((s) => (
          <span
            key={s.key}
            className={`sharebar-seg${hot && hot !== s.key ? ' is-dim' : ''}`}
            style={{ flexGrow: s.share, background: s.color }}
            title={`${s.label}: ${format(s.value)} (${fmtRatio(s.share)})`}
            onMouseEnter={() => setHot(s.key)}
            onMouseLeave={() => setHot(null)}
          />
        ))}
      </div>
      <ul className="sharebar-list">
        {shares.map((s) => (
          <li key={s.key} className={hot && hot !== s.key ? 'is-dim' : undefined} onMouseEnter={() => setHot(s.key)} onMouseLeave={() => setHot(null)}>
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            <span className="sharebar-name">{s.label}</span>
            <span className="sharebar-val">{format(s.value)}</span>
            <span className="sharebar-pct muted">{fmtRatio(s.share)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
