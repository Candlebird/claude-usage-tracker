import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { costOf } from '@ccu/shared';
import { dimOf, emptyState, FLAG_FINAL, loadState, recordIterations, recordTokens, saveState, type SyncState } from '../src/state.js';
import { candidateLineStarts, extractIterations, extractLimitHit, extractTokens, listTranscriptFiles, scanTranscripts } from '../src/transcripts.js';
import { assistantLine, copyFixtures, emptyProjectsDir, fakeResolver, FIXTURE_PROJECTS, iso } from './helpers.js';

function scanFixtures(): { root: string; state: SyncState; result: ReturnType<typeof scanTranscripts> } {
  const root = copyFixtures();
  const state = emptyState();
  const result = scanTranscripts(root, state, { resolveProject: fakeResolver(), now: 1 });
  return { root, state, result };
}

describe('listTranscriptFiles', () => {
  it('finds main, subagent and workflow transcripts and skips journal.jsonl', () => {
    const files = listTranscriptFiles(FIXTURE_PROJECTS).map((f) => [f.rel, f.kind, f.sessionId]);
    expect(files).toEqual(
      expect.arrayContaining([
        ['C--work-alpha/sess-alpha.jsonl', 'main', 'sess-alpha'],
        ['C--work-alpha/sess-alpha/subagents/agent-x1.jsonl', 'subagent', 'sess-alpha'],
        ['C--work-alpha/sess-alpha/subagents/workflows/wf_one/agent-w1.jsonl', 'workflow', 'sess-alpha'],
        ['C--other-app/sess-beta.jsonl', 'main', 'sess-beta'],
      ]),
    );
    expect(files).toHaveLength(5);
    expect(files.some(([rel]) => String(rel).includes('journal'))).toBe(false);
  });
});

describe('scanTranscripts on the synthetic tree', () => {
  it('dedupes split lines, across files, and excludes synthetic/journal lines', () => {
    const { state, result } = scanFixtures();
    expect(Object.keys(state.reqs).sort()).toEqual(['msg_A1', 'msg_A2', 'msg_A3', 'msg_B1', 'msg_G1', 'msg_S1', 'msg_S2', 'msg_W1']);
    expect(result.newRequests).toBe(8);
    expect(result.stats.syntheticLines).toBe(2);
    expect(result.stats.parseErrors).toBe(0); // the malformed api-request-blob line is never parsed
    expect(state.reqs.msg_J1).toBeUndefined();
  });

  it('prefers the line with stop_reason over earlier partial lines', () => {
    const { state } = scanFixtures();
    const a1 = state.reqs.msg_A1!;
    expect(recordTokens(a1)).toEqual({ input: 10, output: 120, cacheRead: 1000, cacheWrite5m: 100, cacheWrite1h: 200, webSearch: 0 });
    expect(a1[8] & FLAG_FINAL).toBe(FLAG_FINAL);
    expect(a1[0]).toBe(iso('2026-01-15T10:00:05Z'));
  });

  it('splits cache writes into 5m/1h and prices them separately', () => {
    const { state } = scanFixtures();
    const t = recordTokens(state.reqs.msg_A1!);
    expect(costOf(t, 'claude-sonnet-4-5')).toBeCloseTo((10 * 3 + 120 * 15 + 1000 * 0.3 + 100 * 3.75 + 200 * 6) / 1e6, 9);
    // No split object: every cache write counts as 5m.
    expect(recordTokens(state.reqs.msg_A3!)).toMatchObject({ cacheWrite5m: 400, cacheWrite1h: 0 });
  });

  it('sums usage.iterations when the top-level counts are all zero', () => {
    const { state } = scanFixtures();
    expect(recordTokens(state.reqs.msg_A2!)).toEqual({ input: 25, output: 40, cacheRead: 0, cacheWrite5m: 50, cacheWrite1h: 0, webSearch: 2 });
  });

  it('keeps per-iteration tokens on the record for pricing', () => {
    const { state } = scanFixtures();
    expect(recordIterations(state.reqs.msg_A2!)).toEqual([
      { input: 20, output: 30, cacheRead: 0, cacheWrite5m: 50, cacheWrite1h: 0, webSearch: 0 },
      { input: 5, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 },
    ]);
    expect(recordIterations(state.reqs.msg_A1!)).toBeUndefined();
    expect(state.reqs.msg_A1!).toHaveLength(9); // single-call requests stay compact
  });

  it('extracts iterations only when there is more than one', () => {
    expect(extractIterations({ iterations: [{ input_tokens: 1, output_tokens: 2 }] } as never)).toBeNull();
    expect(extractIterations({ input_tokens: 1 } as never)).toBeNull();
    expect(extractIterations({ iterations: [{ input_tokens: 1 }, { output_tokens: 2, cache_read_input_tokens: 3 }] } as never)).toEqual([
      { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 },
      { input: 0, output: 2, cacheRead: 3, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 },
    ]);
  });

  it('keeps top-level counts when they are non-zero', () => {
    const t = extractTokens({ input_tokens: 3, output_tokens: 4, iterations: [{ input_tokens: 100, output_tokens: 100 }] } as never);
    expect(t).toMatchObject({ input: 3, output: 4 });
  });

  it('attributes a request seen in a subagent and its parent to the main transcript, with the final tokens', () => {
    const { state } = scanFixtures();
    const s1 = state.reqs.msg_S1!;
    expect(dimOf(state, s1)).toEqual({ project: 'c:/work/alpha', model: 'claude-sonnet-4-5', agentKind: 'main', sessionId: 'sess-alpha' });
    expect(recordTokens(s1)).toMatchObject({ input: 7, output: 40 });
    // ts follows the winning (main) occurrence so the request is bucketed with its attribution.
    expect(s1[0]).toBe(iso('2026-01-15T10:10:00Z'));
    expect(dimOf(state, state.reqs.msg_S2!).agentKind).toBe('subagent');
    expect(dimOf(state, state.reqs.msg_W1!).agentKind).toBe('workflow');
  });

  it('records flags, clean model ids, sessions, projects and limit hits', () => {
    const { state, result } = scanFixtures();
    const a3 = state.reqs.msg_A3!;
    expect(dimOf(state, a3).model).toBe('claude-opus-5-5');
    expect(a3[8]).toBe(1 | 2 | 4);
    const s = state.sessions['sess-alpha']!;
    expect(s).toMatchObject({
      project: 'c:/work/alpha',
      projectFromMain: true,
      title: 'Synthetic alpha session',
      gitBranch: 'main',
      agentCount: 2,
      costStateUsd: 0.5,
      linesAdded: 12,
      linesRemoved: 3,
      firstTs: iso('2026-01-15T10:00:05Z'),
      lastTs: iso('2026-01-15T12:30:00Z'),
    });
    expect([...s.models].sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5', 'claude-sonnet-4-5']);
    expect(Object.keys(state.projects).sort()).toEqual(['c:/other/app', 'c:/work/alpha', 'd:/clients/app']);
    expect(result.limitHits).toEqual([{ ts: iso('2026-01-15T11:00:00Z'), kind: 'five_hour', resetsAt: 1768478400 }]);
    expect(result.sessions.sort()).toEqual(['sess-alpha', 'sess-beta', 'sess-gamma']);
  });
});

describe('limit hits', () => {
  it('normalizes ms epochs and reads quotaLimits', () => {
    expect(extractLimitHit({ apiErrorStatus: 429, quotaLimits: { rateLimitType: 'seven_day', resetsAt: 1768478400000 } }, 5)).toEqual({ ts: 5, kind: 'seven_day', resetsAt: 1768478400 });
    expect(extractLimitHit({ apiErrorStatus: 429, apiErrorParams: { rate_limit_info: {} } }, 5)).toEqual({ ts: 5, kind: 'unknown', resetsAt: null });
    // Per-model weekly limits use the window key the usage API and dashboard use.
    expect(extractLimitHit({ apiErrorStatus: 429, quotaLimits: { rateLimitType: 'seven_day_opus', resetsAt: 1768478400000 } }, 5)).toMatchObject({ kind: 'seven_day:opus' });
    expect(extractLimitHit({ apiErrorStatus: 500, apiErrorParams: { rate_limit_info: { status: 'allowed' } } }, 5)).toBeNull();
  });
});

describe('pre-filter', () => {
  it('returns each matching complete line once', () => {
    const text = '{"type":"user"}\n{"type":"assistant","x":"\\"type\\":\\"cost-state\\""}\n{"type":"cost-state"}\n{"type":"assistant"';
    const buf = Buffer.from(text);
    const starts = candidateLineStarts(buf, buf.lastIndexOf(10) + 1);
    expect(starts.map((s) => text.slice(s, text.indexOf('\n', s)))).toEqual(['{"type":"assistant","x":"\\"type\\":\\"cost-state\\""}', '{"type":"cost-state"}']);
  });
});

describe('incremental reading', () => {
  function setup() {
    const root = emptyProjectsDir();
    const dir = join(root, 'C--work-alpha');
    mkdirSync(dir, { recursive: true });
    return { root, file: join(dir, 'sess-t.jsonl'), state: emptyState(), opts: { resolveProject: fakeResolver(), now: 1 } };
  }

  it('leaves a partial trailing line for the next run', () => {
    const { root, file, state, opts } = setup();
    const l1 = assistantLine({ id: 'm1', ts: '2026-01-15T10:00:00Z', output: 5 });
    const l2 = assistantLine({ id: 'm2', ts: '2026-01-15T10:01:00Z', output: 6 });
    writeFileSync(file, l1 + l2.slice(0, 40));
    expect(scanTranscripts(root, state, opts).newRequests).toBe(1);
    expect(state.files['C--work-alpha/sess-t.jsonl']!.offset).toBe(Buffer.byteLength(l1));
    appendFileSync(file, l2.slice(40));
    const r = scanTranscripts(root, state, opts);
    expect(r.newRequests).toBe(1);
    expect(r.stats.filesReset).toBe(0);
    expect(Object.keys(state.reqs).sort()).toEqual(['m1', 'm2']);
  });

  it('resumes from saved offsets and skips unchanged files', () => {
    const { root, file, state, opts } = setup();
    writeFileSync(file, assistantLine({ id: 'm1', ts: '2026-01-15T10:00:00Z', output: 5, final: false }));
    scanTranscripts(root, state, opts);
    const statePath = join(root, '..', 'state.json');
    saveState(statePath, state);
    const loaded = loadState(statePath);
    const same = scanTranscripts(root, loaded, opts);
    expect(same.stats).toMatchObject({ filesUnchanged: 1, filesRead: 0, bytesRead: 0 });

    const before = loaded.files['C--work-alpha/sess-t.jsonl']!.offset;
    appendFileSync(file, assistantLine({ id: 'm1', ts: '2026-01-15T10:00:01Z', output: 50 }));
    const next = scanTranscripts(root, loaded, opts);
    expect(next.stats.bytesRead).toBe(readFileSync(file).length - before);
    expect(next).toMatchObject({ newRequests: 0, improvedRequests: 1 });
    expect(recordTokens(loaded.reqs.m1!).output).toBe(50);
  });

  it('re-reads a file from 0 when it shrinks', () => {
    const { root, file, state, opts } = setup();
    writeFileSync(file, assistantLine({ id: 'm1', ts: '2026-01-15T10:00:00Z', output: 5, pad: 'x'.repeat(500) }));
    scanTranscripts(root, state, opts);
    writeFileSync(file, assistantLine({ id: 'm9', ts: '2026-01-15T11:00:00Z', output: 9 }));
    const r = scanTranscripts(root, state, opts);
    expect(r.stats.filesReset).toBe(1);
    expect(r.newRequests).toBe(1);
    expect(state.reqs.m9).toBeDefined();
  });

  it('re-reads a file from 0 when it was replaced by a larger one with a different head', () => {
    const { root, file, state, opts } = setup();
    writeFileSync(file, assistantLine({ id: 'm1', ts: '2026-01-15T10:00:00Z', output: 5 }));
    scanTranscripts(root, state, opts);
    writeFileSync(file, assistantLine({ id: 'm7', ts: '2026-01-15T11:00:00Z', output: 7 }) + assistantLine({ id: 'm8', ts: '2026-01-15T11:01:00Z', output: 8 }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const r = scanTranscripts(root, state, opts);
    expect(r.stats.filesReset).toBe(1);
    expect(r.newRequests).toBe(2);
  });

  it('a rescan of the same content from scratch is idempotent', () => {
    const { root, state } = scanFixtures();
    const snapshot = JSON.stringify(state.reqs);
    state.files = {};
    const r = scanTranscripts(root, state, { resolveProject: fakeResolver(), now: 1 });
    expect(r.newRequests).toBe(0);
    expect(r.improvedRequests).toBe(0);
    expect(JSON.stringify(state.reqs)).toBe(snapshot);
    expect(state.sessions['sess-alpha']!.agentCount).toBe(2); // counted once per file ever seen
  });

  it('drops state for files that disappeared', () => {
    const { root, file, state, opts } = setup();
    writeFileSync(file, assistantLine({ id: 'm1', ts: '2026-01-15T10:00:00Z', output: 5 }));
    scanTranscripts(root, state, opts);
    state.files['C--gone/old.jsonl'] = { size: 1, mtimeMs: 1, offset: 1, head: '', sessionId: 'old', kind: 'main' };
    expect(scanTranscripts(root, state, opts).stats.filesRemoved).toBe(1);
    expect(state.files['C--gone/old.jsonl']).toBeUndefined();
    expect(state.reqs.m1).toBeDefined();
  });
});
