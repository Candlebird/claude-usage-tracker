import type { TokenType } from '@ccu/shared';
import { fmtRatio, tokenTypeLabel } from '../../format';
import { tokenTypeColor } from '../../palette';
import type { MixPart } from './derive';

export interface MixBarProps {
  parts: readonly MixPart[];
  /** 'lg' for the card headline bar, 'sm' for a table cell. */
  size?: 'sm' | 'lg';
  label: string;
}

/** 100% composition bar by token type. Segments under 0.5% are dropped; the 2px gap is a surface border. */
export function MixBar({ parts, size = 'lg', label }: MixBarProps) {
  const visible = parts.filter((p) => p.share >= 0.005);
  const desc = visible.map((p) => `${tokenTypeLabel(p.type)} ${fmtRatio(p.share)}`).join(', ');
  return (
    <div className={`mdl-mix mdl-mix-${size}`} role="img" aria-label={`${label}: ${desc || 'no tokens'}`}>
      {visible.map((p) => (
        <span
          key={p.type}
          className="mdl-mix-seg"
          style={{ flexGrow: p.share, background: tokenTypeColor(p.type) }}
          title={`${tokenTypeLabel(p.type)}: ${fmtRatio(p.share)}`}
        />
      ))}
    </div>
  );
}

export function TypeSwatch({ type }: { type: TokenType }) {
  return <span className="swatch" style={{ background: tokenTypeColor(type) }} aria-hidden="true" />;
}
