import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { costOf, hourStartUtc } from '@ccu/shared';
import {
  bucketId,
  buildBuckets,
  buildProjects,
  buildSessions,
  burnRatePerHour,
  computeToday,
  diffDirty,
  diffDirtySessions,
  markPlanUploaded,
  markUploaded,
  outputIncompleteCount,
  pendingLimitHits,
  planUpload,
  unpricedModels,
} from '../src/aggregate.js';
import { emptyState, recordTokens, type SyncState } from '../src/state.js';
import { scanTranscripts } from '../src/transcripts.js';
import { assistantLine, copyFixtures, fakeResolver, iso } from './helpers.js';

function scanned(): { root: string; state: SyncState } {
  const root = copyFixtures();
  const state = emptyState();
  scanTranscripts(root, state, { resolveProject: fakeResolver(), now: 1 });
  return { root, state };
}

describe('buildBuckets', () => {
  it('groups requests by UTC hour and dimension and sums tokens and cost', () => {
    const { state } = scanned();
    const buckets = buildBuckets(state);
    const h10 = hourStartUtc(iso('2026-01-15T10:00:00Z'));
    const mainSonnet = buckets.get(bucketId({ hour: h10, project: 'c:/work/alpha', model: 'claude-sonnet-4-5', agentKind: 'main', sessionId: 'sess-alpha' }))!;
    // msg_A1 + msg_S1 (re-attributed to main) + msg_A2
    expect(mainSonnet).toMatchObject({ requests: 3, input: 10 + 7 + 25, output: 120 + 40 + 40, cacheRead: 1000, cacheWrite5m: 150, cacheWrite1h: 200, webSearch: 2 });
    const expected = ['msg_A1', 'msg_S1', 'msg_A2'].reduce((s, k) => s + costOf(recordTokens(state.reqs[k]!), 'claude-sonnet-4-5'), 0);
    expect(mainSonnet.costUsd).toBeCloseTo(expected, 5); // stored rounded to 6 decimals
    expect(buckets.size).toBe(6); // main sonnet 10h, subagent haiku, workflow sonnet, opus 12h, beta, gamma
    const total = [...buckets.values()].reduce((s, b) => s + b.requests, 0);
    expect(total).toBe(Object.keys(state.reqs).length);
  });

  it('prices fast mode and the US inference-geo surcharge per request', () => {
    const { state } = scanned();
    const b = [...buildBuckets(state).values()].find((x) => x.model === 'claude-opus-5-5')!;
    const t = recordTokens(state.reqs.msg_A3!);
    expect(b.costUsd).toBeCloseTo(costOf(t, 'claude-opus-5-5', { speed: 'fast', inferenceGeo: 'us' }), 6);
    expect(b.costUsd).toBeGreaterThan(costOf(t, 'claude-opus-5-5'));
  });
});

describe('dirty detection', () => {
  it('uploads everything once, then only buckets whose sums changed', () => {
    const { root, state } = scanned();
    const first = diffDirty(state, buildBuckets(state));
    expect(first).toHaveLength(6);
    expect(first[0]!.hour).toBeGreaterThanOrEqual(first.at(-1)!.hour); // newest first
    markUploaded(state, first);
    expect(diffDirty(state, buildBuckets(state))).toEqual([]);

    appendFileSync(join(root, 'C--other-app', 'sess-beta.jsonl'), assistantLine({ id: 'msg_B2', ts: '2026-01-16T08:30:00Z', output: 3, sessionId: 'sess-beta', cwd: 'C:\\other\\app' }));
    scanTranscripts(root, state, { resolveProject: fakeResolver(), now: 2 });
    const dirty = diffDirty(state, buildBuckets(state));
    expect(dirty.map((b) => [b.sessionId, b.requests])).toEqual([['sess-beta', 2]]);
  });

  it('emits a zero row for an uploaded bucket that no longer exists, then forgets it', () => {
    const { state } = scanned();
    markUploaded(state, diffDirty(state, buildBuckets(state)));
    const ghost = `${iso('2026-01-15T10:00:00Z')}\tc:/work/alpha\tclaude-sonnet-4-5\tsubagent\tsess-alpha`;
    state.uploaded.buckets[ghost] = 'stale';
    const dirty = diffDirty(state, buildBuckets(state));
    expect(dirty).toEqual([expect.objectContaining({ agentKind: 'subagent', model: 'claude-sonnet-4-5', requests: 0, output: 0, costUsd: 0 })]);
    markUploaded(state, dirty);
    expect(state.uploaded.buckets[ghost]).toBeUndefined();
    expect(diffDirty(state, buildBuckets(state))).toEqual([]);
  });
});

describe('sessions and projects', () => {
  it('builds session meta and re-sends only changed sessions', () => {
    const { state } = scanned();
    const sessions = buildSessions(state);
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-gamma', 'sess-beta', 'sess-alpha']);
    expect(sessions.find((s) => s.sessionId === 'sess-alpha')).toMatchObject({ project: 'c:/work/alpha', agentCount: 2, costStateUsd: 0.5, title: 'Synthetic alpha session' });
    markPlanUploaded(state, { buckets: [], sessions, projects: [], limitHits: [] });
    expect(diffDirtySessions(state, buildSessions(state))).toEqual([]);
    state.sessions['sess-beta']!.title = 'renamed';
    expect(diffDirtySessions(state, buildSessions(state)).map((s) => s.sessionId)).toEqual(['sess-beta']);
  });

  it('labels colliding project names with their parent segment', () => {
    const { state } = scanned();
    const labels = Object.fromEntries(buildProjects(state).map((p) => [p.project, p.label]));
    expect(labels).toEqual({ 'c:/work/alpha': 'alpha', 'c:/other/app': 'other/app', 'd:/clients/app': 'clients/app' });
  });
});

describe('planUpload', () => {
  it('fits the row budget: metadata first, then buckets newest first, reporting pending', () => {
    const { state } = scanned();
    // 3 projects + 1 hit + 3 sessions = 7 metadata rows, 6 buckets.
    const plan = planUpload(state, { maxRows: 9 });
    expect(plan).toMatchObject({ rows: 9, pending: 4, outsideWindow: 0 });
    expect(plan.projects).toHaveLength(3);
    expect(plan.limitHits).toHaveLength(1);
    expect(plan.sessions).toHaveLength(3);
    expect(plan.buckets.map((b) => b.sessionId)).toEqual(['sess-gamma', 'sess-beta']);
    markPlanUploaded(state, plan);
    expect(pendingLimitHits(state)).toEqual([]);

    const next = planUpload(state, { maxRows: 9 });
    expect(next).toMatchObject({ rows: 4, pending: 0 });
    expect(next.buckets[0]!.hour).toBe(hourStartUtc(iso('2026-01-15T12:30:00Z')));
    markPlanUploaded(state, next);
    expect(planUpload(state).rows).toBe(0);
  });

  it('honours sinceTs (backfill window)', () => {
    const { state } = scanned();
    const plan = planUpload(state, { sinceTs: iso('2026-01-16T00:00:00Z') });
    expect(plan.buckets.map((b) => b.sessionId)).toEqual(['sess-gamma', 'sess-beta']);
    expect(plan.outsideWindow).toBe(4);
    expect(plan.sessions.map((s) => s.sessionId)).toEqual(['sess-gamma', 'sess-beta']);
    expect(plan.limitHits).toEqual([]);
  });
});

describe('local summaries', () => {
  it('computes today in the given timezone and the last-hour burn rate', () => {
    const { state } = scanned();
    const today = computeToday(state, 'UTC', iso('2026-01-15T23:00:00Z'));
    expect(today.requests).toBe(6);
    expect(today.tokens).toBe(10 + 120 + 1000 + 300 + 25 + 40 + 50 + 47 + 10 + 10 + 550);
    // Jan 16 starts at 08:00Z in Los Angeles, so beta (08:00Z) and gamma (09:00Z) are today there.
    expect(computeToday(state, 'America/Los_Angeles', iso('2026-01-16T09:30:00Z')).requests).toBe(2);

    const burn = burnRatePerHour(state, iso('2026-01-15T12:45:00Z'));
    expect(burn).toBeCloseTo(costOf(recordTokens(state.reqs.msg_A3!), 'claude-opus-5-5', { speed: 'fast', inferenceGeo: 'us' }), 6);
  });

  it('counts requests without a final line and flags unpriced models', () => {
    const { state } = scanned();
    expect(outputIncompleteCount(state)).toBe(0);
    state.reqs.msg_B1![8] = 0;
    expect(outputIncompleteCount(state)).toBe(1);
    expect(unpricedModels(state)).toEqual([]);
  });
});
