import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** 'system' follows prefers-color-scheme (dark when the OS has no preference). */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'ccu.theme';

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const el = document.documentElement;
  if (choice === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
}

function systemTheme(): ResolvedTheme {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === 'system' ? systemTheme() : choice;
}

// Module-level so every useTheme() caller (top bar toggle, Settings) sees the same choice.
let current: ThemeChoice | null = null;
const listeners = new Set<() => void>();
function getChoice(): ThemeChoice {
  if (current === null) current = loadTheme();
  return current;
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Theme choice plus the resolved light/dark value; `toggle` flips the resolved value. */
export function useTheme(): { choice: ThemeChoice; resolved: ResolvedTheme; setChoice: (c: ThemeChoice) => void; toggle: () => void } {
  const choice = useSyncExternalStore(subscribe, getChoice, getChoice);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(choice));

  useEffect(() => {
    setResolved(resolveTheme(choice));
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const on = () => setResolved(resolveTheme('system'));
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    applyTheme(c);
    current = c;
    listeners.forEach((l) => l());
  }, []);
  const toggle = useCallback(() => setChoice(resolveTheme(choice) === 'dark' ? 'light' : 'dark'), [choice, setChoice]);
  return { choice, resolved, setChoice, toggle };
}
