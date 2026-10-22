import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'ccu-lock-')), 'sync.lock');

describe('lock', () => {
  it('is exclusive while held and reusable after release', () => {
    const p = lockPath();
    const a = acquireLock(p);
    expect(a).not.toBeNull();
    expect(acquireLock(p, { isAlive: () => true })).toBeNull();
    a!.release();
    expect(existsSync(p)).toBe(false);
    const b = acquireLock(p);
    expect(b).not.toBeNull();
    b!.release();
  });

  it('takes over a lock whose pid is dead', () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: 999999, ts: 0 }));
    const l = acquireLock(p, { isAlive: () => false });
    expect(l).not.toBeNull();
    l!.release();
  });

  it('takes over a lock older than the stale age even if the pid looks alive', () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: process.pid, ts: 0 }));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(p, old, old);
    expect(acquireLock(p, { isAlive: () => true })).not.toBeNull();
  });

  it('keeps a fresh unreadable lock', () => {
    const p = lockPath();
    writeFileSync(p, 'not json');
    expect(acquireLock(p)).toBeNull();
  });

  it('does not steal a fresh lock from a live process', () => {
    const p = lockPath();
    writeFileSync(p, JSON.stringify({ pid: 4242, ts: 0, nonce: 'other' }));
    expect(acquireLock(p, { isAlive: () => true, heartbeatMs: 0 })).toBeNull();
    expect(JSON.parse(readFileSync(p, 'utf8')).nonce).toBe('other');
  });

  it('after a takeover, the old holder neither refreshes nor deletes the new lock', () => {
    const p = lockPath();
    const a = acquireLock(p, { heartbeatMs: 0 })!;
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(p, old, old);
    const b = acquireLock(p, { isAlive: () => true, heartbeatMs: 0 })!;
    expect(b).not.toBeNull();
    const owner = readFileSync(p, 'utf8');
    expect(a.refresh()).toBe(false);
    a.release();
    expect(readFileSync(p, 'utf8')).toBe(owner);
    expect(b.refresh()).toBe(true);
    b.release();
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dirname(p))).toEqual([]); // no leftover .stale-* files
  });

  it('refresh() bumps the mtime so a long run does not look abandoned', () => {
    const p = lockPath();
    const l = acquireLock(p, { heartbeatMs: 0 })!;
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(p, old, old);
    expect(l.refresh()).toBe(true);
    expect(Date.now() - statSync(p).mtimeMs).toBeLessThan(60_000);
    expect(acquireLock(p, { heartbeatMs: 0 })).toBeNull();
    l.release();
  });
});
