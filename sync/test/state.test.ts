import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyUsage } from '@ccu/shared';
import { buildBuckets, diffDirty, markUploaded } from '../src/aggregate.js';
import { dimOf, emptyState, loadState, mergeRequest, pruneHourCutoff, pruneState, saveState, type Dim } from '../src/state.js';

const main: Dim = { project: 'c:/p', model: 'claude-sonnet-4-5', agentKind: 'main', sessionId: 's' };
const sub: Dim = { ...main, agentKind: 'subagent' };
const tokens = (output: number) => ({ ...emptyUsage(), input: 1, output });

describe('mergeRequest', () => {
  it('prefers final lines, then higher output', () => {
    const s = emptyState();
    expect(mergeRequest(s, { key: 'k', ts: 10, dim: main, tokens: tokens(50), final: false, fast: false, geoUs: false })).toBe('new');
    expect(mergeRequest(s, { key: 'k', ts: 11, dim: main, tokens: tokens(60), final: false, fast: false, geoUs: false })).toBe('improved');
    expect(mergeRequest(s, { key: 'k', ts: 12, dim: main, tokens: tokens(20), final: true, fast: false, geoUs: false })).toBe('improved');
    expect(s.reqs.k![3]).toBe(20); // the final line wins even with lower output
    expect(mergeRequest(s, { key: 'k', ts: 13, dim: main, tokens: tokens(99), final: false, fast: false, geoUs: false })).toBe('duplicate');
    expect(s.reqs.k![0]).toBe(10);
  });

  it('attributes to the main transcript over a subagent one regardless of order', () => {
    const s = emptyState();
    mergeRequest(s, { key: 'k', ts: 5, dim: sub, tokens: tokens(1), final: true, fast: false, geoUs: false });
    mergeRequest(s, { key: 'k', ts: 9, dim: main, tokens: tokens(1), final: true, fast: false, geoUs: false });
    expect(dimOf(s, s.reqs.k!).agentKind).toBe('main');
    expect(s.reqs.k![0]).toBe(9); // ts follows the winning (main) occurrence
    mergeRequest(s, { key: 'k', ts: 1, dim: sub, tokens: tokens(1), final: true, fast: false, geoUs: false });
    expect(dimOf(s, s.reqs.k!).agentKind).toBe('main');
    expect(s.reqs.k![0]).toBe(9);
  });

  it('buckets a request under the hour of the occurrence it is attributed to', () => {
    const s = emptyState();
    const h10 = 1_700_002_800; // a UTC hour start
    mergeRequest(s, { key: 'k', ts: h10 + 59 * 60, dim: sub, tokens: tokens(1), final: true, fast: false, geoUs: false });
    mergeRequest(s, { key: 'k', ts: h10 + 3600 + 60, dim: main, tokens: tokens(1), final: true, fast: false, geoUs: false });
    const ids = [...buildBuckets(s).keys()];
    expect(ids).toHaveLength(1);
    expect(ids[0]!.startsWith(`${h10 + 3600}	`)).toBe(true);
    expect(ids[0]).toContain('	main	');
  });

  it('keeps the earliest ts among occurrences of the same kind', () => {
    const s = emptyState();
    mergeRequest(s, { key: 'k', ts: 50, dim: main, tokens: tokens(1), final: true, fast: false, geoUs: false });
    mergeRequest(s, { key: 'k', ts: 40, dim: main, tokens: tokens(1), final: true, fast: false, geoUs: false });
    mergeRequest(s, { key: 'k', ts: 60, dim: main, tokens: tokens(1), final: true, fast: false, geoUs: false });
    expect(s.reqs.k![0]).toBe(40);
  });
});

describe('persistence and pruning', () => {
  it('round-trips and tolerates missing or corrupt files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccu-state-'));
    const path = join(dir, 'nested', 'state.json');
    expect(loadState(path)).toEqual(emptyState());
    const s = emptyState();
    mergeRequest(s, { key: 'k', ts: 5, dim: main, tokens: tokens(1), final: true, fast: true, geoUs: false });
    saveState(path, s);
    expect(loadState(path)).toEqual(s);
    writeFileSync(path, '{not json');
    expect(loadState(path)).toEqual(emptyState());
    writeFileSync(path, JSON.stringify({ ...s, version: 999 }));
    expect(loadState(path)).toEqual(emptyState());
  });

  it('prunes old records and upload hashes and compacts dims', () => {
    const s = emptyState();
    const now = 1_000 * 86400;
    mergeRequest(s, { key: 'old', ts: now - 401 * 86400, dim: sub, tokens: tokens(1), final: true, fast: false, geoUs: false });
    mergeRequest(s, { key: 'new', ts: now - 86400, dim: main, tokens: tokens(1), final: true, fast: false, geoUs: false });
    s.uploaded.buckets[`${now - 401 * 86400}\tx`] = 'h';
    s.uploaded.buckets[`${now - 3600}\tx`] = 'h';
    pruneState(s, now);
    expect(Object.keys(s.reqs)).toEqual(['new']);
    expect(s.dims).toHaveLength(1);
    expect(dimOf(s, s.reqs.new!)).toEqual(main);
    expect(Object.keys(s.uploaded.buckets)).toEqual([`${now - 3600}\tx`]);
    // Interning still works after compaction.
    mergeRequest(s, { key: 'n2', ts: now, dim: sub, tokens: tokens(1), final: true, fast: false, geoUs: false });
    expect(s.dims).toHaveLength(2);
  });
  it('never re-sends a shrunk or zeroed bucket for an hour crossing the prune cutoff', () => {
    const s = emptyState();
    const days = 400;
    const base = 1_000 * 86400; // UTC midnight
    const hour = base - days * 86400; // the hour that will straddle the cutoff
    for (let m = 0; m < 60; m += 10) {
      mergeRequest(s, { key: `r${m}`, ts: hour + m * 60, dim: main, tokens: tokens(1), final: true, fast: false, geoUs: false });
    }
    markUploaded(s, [...buildBuckets(s).values()]);
    // Walk "now" through the hour, minute by minute, as 5-minute syncs would.
    for (let now = base; now <= base + 2 * 3600; now += 60) {
      pruneState(s, now, days);
      for (const b of diffDirty(s, buildBuckets(s))) expect(b.hour).toBeGreaterThanOrEqual(pruneHourCutoff(now, days));
      expect(diffDirty(s, buildBuckets(s))).toEqual([]);
    }
    expect(Object.keys(s.reqs)).toEqual([]);
    expect(Object.keys(s.uploaded.buckets)).toEqual([]);
  });
});
