// ~/.claude-usage/cache.json: written every sync run, read by the statusline without network.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ARRAY_LIMITS,
  STRING_LIMITS,
  dayKey,
  isoToUnix,
  parseCacheFile,
  type CacheError,
  type CacheFile,
  type CacheLimitWindow,
  type LimitSnapshot,
  type UnixSeconds,
} from '@ccu/shared';

/** Errors older than this are dropped from the cache so a fixed problem stops showing. */
export const CACHE_ERROR_TTL_SECONDS = 24 * 3600;
const MAX_CACHE_ERRORS = 20;

export function readCacheFile(path: string): CacheFile | null {
  try {
    return parseCacheFile(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function toCacheWindows(s: LimitSnapshot): CacheLimitWindow[] {
  const out: CacheLimitWindow[] = [];
  for (const w of s.windows) {
    const resetsAt = isoToUnix(w.resetsAt);
    if (resetsAt == null) continue;
    out.push({ key: w.key, label: w.label, utilization: w.utilization, resetsAt, severity: w.severity ?? null });
  }
  return out;
}

export interface CacheInput {
  now: UnixSeconds;
  tz: string;
  prev: CacheFile | null;
  /** Fresh limits from this run, or null when the poll failed / was skipped (keep the previous ones). */
  limits: { snapshot: LimitSnapshot; extraUsageEnabled: boolean | null } | null;
  /** Set when this run acknowledged an upload. */
  syncedTs: UnixSeconds | null;
  today: { costUsd: number; tokens: number; requests: number };
  burnRatePerHour: number;
  pending: number;
  errors: Omit<CacheError, 'ts'>[];
}

function clampMsg(s: string): string {
  return s.length > STRING_LIMITS.error ? `${s.slice(0, STRING_LIMITS.error - 3)}...` : s;
}

export function buildCacheFile(i: CacheInput): CacheFile {
  const newErrors: CacheError[] = i.errors.map((e) => ({ ts: i.now, source: e.source, message: clampMsg(e.message) }));
  // Earlier errors stay visible for a day, then age out.
  const older = (i.prev?.errors ?? []).filter((e) => i.now - e.ts < CACHE_ERROR_TTL_SECONDS);
  const errors = [...newErrors, ...older].slice(0, Math.min(MAX_CACHE_ERRORS, ARRAY_LIMITS.errors));

  const limits: CacheFile['limits'] = i.limits
    ? { fetchedTs: i.limits.snapshot.ts, windows: toCacheWindows(i.limits.snapshot), extraUsageEnabled: i.limits.extraUsageEnabled }
    : (i.prev?.limits ?? { fetchedTs: null, windows: [], extraUsageEnabled: null });

  return {
    version: 1,
    updatedTs: i.now,
    lastSyncTs: i.syncedTs ?? i.prev?.lastSyncTs ?? null,
    tz: i.tz,
    limits,
    today: { day: dayKey(i.now, i.tz), ...i.today },
    burnRatePerHour: i.burnRatePerHour,
    pending: i.pending,
    errors,
  };
}

/** Atomic write (temp file + rename) so the statusline never reads a half-written file. */
export function writeCacheFile(path: string, cache: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, path);
}
