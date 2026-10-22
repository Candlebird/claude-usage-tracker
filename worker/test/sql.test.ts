import { describe, expect, it } from 'vitest';
import { buildInserts, MAX_BOUND_PARAMS, MAX_ROWS_PER_STATEMENT, upsertClause } from '../src/sql.js';
import { bucketStatements, liveRequestStatements } from '../src/upserts.js';

const spec = { table: 't', columns: ['a', 'b', 'c'] };

describe('buildInserts', () => {
  it('binds strings and inlines numbers and nulls', () => {
    const [s] = buildInserts(spec, [['x', 1.5, null]]);
    expect(s!.sql).toBe('INSERT INTO t (a,b,c) VALUES (?1,1.5,NULL)');
    expect(s!.params).toEqual(['x']);
    expect(s!.rows).toBe(1);
  });

  it('reuses one parameter for repeated strings', () => {
    const [s] = buildInserts(spec, [['dev', 'm', 1], ['dev', 'm', 2], ['dev', 'other', 3]]);
    expect(s!.params).toEqual(['dev', 'm', 'other']);
    expect(s!.sql).toContain('(?1,?2,1),(?1,?2,2),(?1,?3,3)');
  });

  it('never exceeds the bound parameter limit', () => {
    const rows = Array.from({ length: 450 }, (_, i) => [`a${i}`, `b${i}`, i]);
    const built = buildInserts(spec, rows);
    expect(built.length).toBe(Math.ceil(900 / MAX_BOUND_PARAMS));
    for (const s of built) expect(s.params.length).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
    expect(built.reduce((n, s) => n + s.rows, 0)).toBe(450);
  });

  it('caps rows per statement even when nothing is bound', () => {
    const rows = Array.from({ length: 250 }, (_, i) => [i, i, i]);
    expect(buildInserts(spec, rows).map((s) => s.rows)).toEqual([MAX_ROWS_PER_STATEMENT, MAX_ROWS_PER_STATEMENT, 50]);
  });

  it('respects a custom parameter limit', () => {
    const built = buildInserts(spec, Array.from({ length: 10 }, (_, i) => [`a${i}`, `b${i}`, i]), 4);
    expect(built.length).toBe(5);
    for (const s of built) expect(s.params.length).toBeLessThanOrEqual(4);
  });

  it('rejects malformed rows', () => {
    expect(() => buildInserts(spec, [['x', 1]])).toThrow(/expected 3/);
    expect(() => buildInserts(spec, [['x', Number.NaN, 1]])).toThrow(/non-finite/);
  });

  it('returns nothing for no rows', () => {
    expect(buildInserts(spec, [])).toEqual([]);
  });

  it('builds upsert clauses with overrides', () => {
    expect(upsertClause(['k'], ['a', 'b'], { b: 'COALESCE(excluded.b, t.b)' })).toBe(
      'ON CONFLICT(k) DO UPDATE SET a=excluded.a,b=COALESCE(excluded.b, t.b)',
    );
  });
});

describe('ingest statement counts', () => {
  it('fits 500 buckets with distinct sessions in a handful of statements', () => {
    const buckets = Array.from({ length: 500 }, (_, i) => ({
      hour: 1_800_000_000 + (i % 24) * 3600,
      project: `c:/synthetic/p${i % 3}`,
      model: 'claude-test-model',
      agentKind: 'main' as const,
      sessionId: `session-${i}`,
      input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, webSearch: 0, requests: 1, costUsd: 0.01,
    }));
    const built = bucketStatements(buckets, 'test-device');
    expect(built.length).toBeLessThanOrEqual(6);
    for (const s of built) expect(s.params.length).toBeLessThanOrEqual(MAX_BOUND_PARAMS);
  });

  it('packs live requests into few statements', () => {
    const reqs = Array.from({ length: 200 }, (_, i) => ({
      requestId: `req_${i}`, ts: 1_800_000_000, sessionId: 'sess-a', model: 'claude-test-model',
      input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0.001,
      durationMs: 10, ttftMs: 5, speed: 'normal', effort: null, querySource: 'repl_main_thread',
    }));
    expect(liveRequestStatements(reqs).length).toBeLessThanOrEqual(3);
  });
});
