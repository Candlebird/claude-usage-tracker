import type { KeyboardEvent } from 'react';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

export interface SegmentedProps<V extends string> {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange(v: V): void;
  /** Accessible group name, e.g. "Date range". */
  label: string;
  size?: 'sm' | 'md';
}

/** Single-choice button group (radio semantics, arrow keys move the choice). */
export function Segmented<V extends string>({ options, value, onChange, label, size = 'md' }: SegmentedProps<V>) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]!;
    onChange(next.value);
    (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-value={o.value}
            className={on ? 'is-on' : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
