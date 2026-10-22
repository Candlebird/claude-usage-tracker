import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A lock whose mtime is older than this is considered abandoned even if its pid looks alive (pid
 * reuse). Holders refresh the mtime (heartbeat + explicit `refresh()`), so a live sync never ages
 * past it.
 */
export const LOCK_STALE_MS = 15 * 60 * 1000;
export const LOCK_HEARTBEAT_MS = 60 * 1000;
/** A half-written or unreadable lock gets this long before it counts as abandoned. */
const UNREADABLE_GRACE_MS = 60_000;

export interface LockOptions {
  staleMs?: number;
  now?: () => number;
  /** Whether a pid is still running; injectable for tests. */
  isAlive?: (pid: number) => boolean;
  /** Heartbeat interval; 0 disables it. */
  heartbeatMs?: number;
}

export interface Lock {
  /** Bumps the lock's mtime if we still own it; returns false when the lock was taken over. */
  refresh(): boolean;
  /** Removes the lock file, but only while it is still ours. */
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isStale(text: string, mtimeMs: number, opts: Required<LockOptions>): boolean {
  const age = opts.now() - mtimeMs;
  let pid: number;
  try {
    pid = Number(JSON.parse(text).pid);
  } catch {
    return age > UNREADABLE_GRACE_MS;
  }
  if (!Number.isInteger(pid) || pid <= 0) return age > UNREADABLE_GRACE_MS;
  if (!opts.isAlive(pid)) return true;
  return age > opts.staleMs;
}

function tryCreate(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Moves a stale lock out of the way atomically. The rename only counts if the file we moved is the
 * exact one judged stale; if another process replaced it meanwhile, we put theirs back.
 */
function removeStale(path: string, staleText: string, nonce: string): void {
  const aside = `${path}.stale-${nonce}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // already gone or being replaced; the create below decides
  }
  const moved = readText(aside);
  if (moved !== staleText && moved !== null) {
    // We grabbed a fresh lock that someone else just created: restore it.
    try {
      tryCreate(path, moved);
    } catch {
      // nothing more we can do; the create below will fail or succeed on its own
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // ignore
  }
}

function makeLock(path: string, content: string, opts: Required<LockOptions>): Lock {
  let released = false;
  const owned = () => !released && readText(path) === content;
  const refresh = () => {
    if (!owned()) return false;
    try {
      const t = new Date(opts.now());
      utimesSync(path, t, t);
      return true;
    } catch {
      return false;
    }
  };
  const timer = opts.heartbeatMs > 0 ? setInterval(refresh, opts.heartbeatMs) : null;
  timer?.unref();
  return {
    refresh,
    release() {
      if (released) return;
      if (timer) clearInterval(timer);
      const mine = owned();
      released = true;
      if (!mine) return;
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}

/** Exclusive lock file. Returns null when another live process holds it. Stale locks are taken over. */
export function acquireLock(path: string, options: LockOptions = {}): Lock | null {
  const opts: Required<LockOptions> = {
    staleMs: options.staleMs ?? LOCK_STALE_MS,
    now: options.now ?? Date.now,
    isAlive: options.isAlive ?? pidAlive,
    heartbeatMs: options.heartbeatMs ?? LOCK_HEARTBEAT_MS,
  };
  mkdirSync(dirname(path), { recursive: true });
  const nonce = randomBytes(8).toString('hex');
  const content = JSON.stringify({ pid: process.pid, ts: Math.floor(opts.now() / 1000), nonce });
  if (tryCreate(path, content)) return makeLock(path, content, opts);
  let text: string | null;
  let mtimeMs: number;
  try {
    text = readText(path);
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    text = null;
    mtimeMs = -Infinity;
  }
  if (text === null) {
    // Vanished between our create and the read: one more try.
    return tryCreate(path, content) ? makeLock(path, content, opts) : null;
  }
  if (!isStale(text, mtimeMs, opts)) return null;
  removeStale(path, text, nonce);
  return tryCreate(path, content) ? makeLock(path, content, opts) : null;
}
