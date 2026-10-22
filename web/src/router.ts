import { useEffect, useState } from 'react';

/** Hash routes (GitHub Pages has no SPA fallback): `#/sessions/abc?tab=models`. */
export interface Route {
  /** Path without the leading `#`, always starting with `/`. */
  path: string;
  /** Path segments: `/sessions/abc` -> ['sessions', 'abc']. */
  segments: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const path = '/' + pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean).map(safeDecode);
  return { path, segments, query };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** True when demo mode was entered through the hash (`#/?demo`), which every link must carry forward. */
function hashHasDemo(): boolean {
  return typeof window !== 'undefined' && parseHash(window.location.hash).query.has('demo');
}

/**
 * Builds `#/path?query`. Query values that are null/undefined/'' are dropped.
 * A `demo` flag in the current hash is kept so a reload stays in demo mode.
 */
export function href(path: string, query?: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v != null && v !== '') q.set(k, String(v));
  if (!q.has('demo') && hashHasDemo()) q.set('demo', '');
  const qs = q.toString();
  return `#${path.startsWith('/') ? path : '/' + path}${qs ? '?' + qs : ''}`;
}

export function navigate(path: string, query?: Record<string, string | number | null | undefined>, replace = false): void {
  const next = href(path, query);
  if (replace) window.history.replaceState(null, '', next);
  else window.location.hash = next;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Updates query params on the current route, keeping the others. */
export function setQuery(patch: Record<string, string | number | null | undefined>, replace = true): void {
  const r = parseHash(window.location.hash);
  const q: Record<string, string> = {};
  r.query.forEach((v, k) => (q[k] = v));
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') delete q[k];
    else q[k] = String(v);
  }
  navigate(r.path, q, replace);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** Matches `/sessions/:id` style patterns; returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = safeDecode(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}
