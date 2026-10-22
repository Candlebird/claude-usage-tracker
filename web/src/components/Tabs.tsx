import type { KeyboardEvent, ReactNode } from 'react';

export interface TabDef<V extends string> {
  value: V;
  label: ReactNode;
}

export interface TabsProps<V extends string> {
  tabs: readonly TabDef<V>[];
  value: V;
  onChange(v: V): void;
  label: string;
  /** Prefix for tab/panel ids so TabPanel can reference them. */
  idBase: string;
}

/** Underlined tab strip (ARIA tablist). Pair with <TabPanel> for the content. */
export function Tabs<V extends string>({ tabs, value, onChange, label, idBase }: TabsProps<V>) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.value === value);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    onChange(next.value);
    document.getElementById(`${idBase}-tab-${next.value}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            id={`${idBase}-tab-${t.value}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`${idBase}-panel`}
            tabIndex={on ? 0 : -1}
            className={on ? 'is-on' : undefined}
            onClick={() => onChange(t.value)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, value, children }: { idBase: string; value: string; children: ReactNode }) {
  return (
    <div id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-tab-${value}`} className="tab-panel">
      {children}
    </div>
  );
}
