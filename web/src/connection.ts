/** API connection settings, kept in this browser's localStorage only. */
export interface Connection {
  apiUrl: string;
  token: string;
}

const KEY = 'ccu.connection';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadConnection(): Connection | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Connection>;
    return typeof v.apiUrl === 'string' && typeof v.token === 'string' && v.apiUrl && v.token
      ? { apiUrl: v.apiUrl, token: v.token }
      : null;
  } catch {
    return null;
  }
}

export function saveConnection(c: Connection): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage blocked: the session still works until reload */
  }
}

export function clearConnection(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Trims, adds https:// when no scheme is given, drops trailing slashes. */
export function normalizeApiUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

export function defaultApiUrl(): string {
  return (import.meta.env.VITE_DEFAULT_API_URL ?? '').trim();
}

/** Demo mode: `?demo` in the query string or hash, or a VITE_DEMO build. */
export function isDemoMode(loc: Pick<Location, 'search' | 'hash'> = window.location): boolean {
  const env = String(import.meta.env.VITE_DEMO ?? '').toLowerCase();
  if (env === '1' || env === 'true') return true;
  const hashQuery = loc.hash.includes('?') ? loc.hash.slice(loc.hash.indexOf('?')) : '';
  return new URLSearchParams(loc.search).has('demo') || new URLSearchParams(hashQuery).has('demo');
}
