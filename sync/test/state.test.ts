import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { costOf, emptyUsage } from '@ccu/shared';
import { buildBuckets, diffDirty, markUploaded } from '../src/aggregate.js';
import { requestCost } from '../src/aggregate.js';
import {
  addRowsWritten,
  dimOf,
  emptyState,
  loadState,
  mergeRequest,
  pruneHourCutoff,
  pruneState,
  recordIterations,
  rowBudget,
  rowsWrittenToday,
  saveState,
  type Dim,
  type ReqRecord,
} from '../src/state.js';

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

describe('per-iteration tokens', () => {
  const it1 = { ...emptyUsage(), input: 60_000, output: 100 };
  const it2 = { ...emptyUsage(), input: 2_000, cacheRead: 60_000, output: 200 };
  const top = { ...emptyUsage(), input: 62_000, cacheRead: 60_000, output: 300 };
  const haiku: Dim = { ...main, model: 'claude-haiku-5-5' };

  it('stores iterations compactly and prices each call on its own', () => {
    const s = emptyState();
    mergeRequest(s, { key: 'k', ts: 1, dim: haiku, tokens: top, iterations: [it1, it2], final: true, fast: false, geoUs: false });
    expect(s.reqs.k![9]).toEqual([60_000, 100, 0, 0, 0, 2_000, 200, 60_000, 0, 0]);
    expect(recordIterations(s.reqs.k!)).toEqual([it1, it2]);
    // Neither call alone passes the 100k long-prompt tier, though the sum does.
    expect(requestCost(s.reqs.k!, 'claude-haiku-5-5')).toBeCloseTo(costOf(top, 'claude-haiku-5-5', { iterations: [it1, it2] }), 12);
    expect(requestCost(s.reqs.k!, 'claude-haiku-5-5')).toBeLessThan(costOf(top, 'claude-haiku-5-5'));
  });

  it('moves iterations with the winning tokens and drops them when the winner has none', () => {
    const s = emptyState();
    mergeRequest(s, { key: 'k', ts: 1, dim: haiku, tokens: { ...top, output: 10 }, iterations: [it1, it2], final: false, fast: false, geoUs: false });
    mergeRequest(s, { key: 'k', ts: 1, dim: haiku, tokens: { ...top, output: 5 }, iterations: [it2, it1], final: false, fast: false, geoUs: false });
    expect(recordIterations(s.reqs.k!)).toEqual([it1, it2]); // lower output lost
    mergeRequest(s, { key: 'k', ts: 1, dim: haiku, tokens: top, iterations: null, final: true, fast: false, geoUs: false });
    expect(s.reqs.k!).toHaveLength(9);
    expect(recordIterations(s.reqs.k!)).toBeUndefined();
  });

  it('prices old 9-element records from the top-level tokens', () => {
    const s = emptyState();
    mergeRequest(s, { key: 'k', ts: 1, dim: haiku, tokens: top, final: true, fast: false, geoUs: false });
    const rec: ReqRecord = s.reqs.k!;
    expect(rec).toHaveLength(9);
    expect(requestCost(rec, 'claude-haiku-5-5')).toBeCloseTo(costOf(top, 'claude-haiku-5-5'), 12);
  });
});

describe('daily row budget', () => {
  const day1 = Date.UTC(2027, 0, 15, 23, 0) / 1000;
  const day2 = day1 + 2 * 3600; // 01:00 UTC the next day

  it('limits each run to what is left of the UTC day', () => {
    const s = emptyState();
    expect(rowBudget(s, day1, 5000, 80_000)).toBe(5000);
    addRowsWritten(s, 78_000, day1);
    addRowsWritten(s, 500, day1);
    expect(rowsWrittenToday(s, day1)).toBe(78_500);
    expect(rowBudget(s, day1, 5000, 80_000)).toBe(1500);
    addRowsWritten(s, 2000, day1);
    expect(rowBudget(s, day1, 5000, 80_000)).toBe(0);
  });

  it('resets on a new UTC day', () => {
    const s = emptyState();
    addRowsWritten(s, 90_000, day1);
    expect(rowsWrittenToday(s, day2)).toBe(0);
    expect(rowBudget(s, day2, 5000, 80_000)).toBe(5000);
    addRowsWritten(s, 10, day2);
    expect(s.rowsToday).toEqual({ day: '2027-01-16', rows: 10 });
  });
});

describe('persistence and pruning', () => {
  it('migrates older state: missing row counter, legacy limit-hit kinds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccu-state-'));
    const path = join(dir, 'state.json');
    const old = emptyState() as Partial<ReturnType<typeof emptyState>>;
    delete old.rowsToday;
    old.limitHits = {
      '10|seven_day_opus': { ts: 10, kind: 'seven_day_opus', resetsAt: 99, uploaded: true },
      '10|seven_day:opus': { ts: 10, kind: 'seven_day:opus', resetsAt: null, uploaded: false },
      '20|seven_day_sonnet': { ts: 20, kind: 'seven_day_sonnet', resetsAt: null, uploaded: true },
      '30|five_hour': { ts: 30, kind: 'five_hour', resetsAt: 40, uploaded: true },
    };
    writeFileSync(path, JSON.stringify(old));
    const s = loadState(path);
    expect(s.rowsToday).toEqual({ day: '', rows: 0 });
    expect(s.limitHits).toEqual({
      '10|seven_day:opus': { ts: 10, kind: 'seven_day:opus', resetsAt: 99, uploaded: false },
      '20|seven_day:sonnet': { ts: 20, kind: 'seven_day:sonnet', resetsAt: null, uploaded: true },
      '30|five_hour': { ts: 30, kind: 'five_hour', resetsAt: 40, uploaded: true },
    });
  });

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
