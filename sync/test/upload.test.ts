import type { HourlyBucket, SessionMeta } from '@ccu/shared';
import { validateUsageIngest } from '@ccu/shared';
import { describe, expect, it, vi } from 'vitest';
import { chunkPlan, dropInvalidRows, postJson, splitChunk, uploadPlan, type PlanRows } from '../src/upload.js';

const bucket = (i: number): HourlyBucket => ({
  hour: 1772366400 - i * 3600,
  project: 'c:/work/alpha',
  model: 'claude-sonnet-4-5',
  agentKind: 'main',
  sessionId: 'sess-a',
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  webSearch: 0,
  requests: 1,
  costUsd: 0.01,
});
const session: SessionMeta = { sessionId: 'sess-a', project: 'c:/work/alpha', firstTs: 1772300000, lastTs: 1772366400, models: ['claude-sonnet-4-5'], agentCount: 0 };
const plan = (n: number): PlanRows => ({
  buckets: Array.from({ length: n }, (_, i) => bucket(i)),
  sessions: [session],
  projects: [{ project: 'c:/work/alpha', label: 'alpha' }],
  limitHits: [],
});
const noSleep = vi.fn(async () => {});
const ok = () => Response.json({ ok: true, accepted: {} });
const opts = { apiUrl: 'https://api.example.invalid/', writeToken: 'synthetic-write', device: 'pc', version: '2.0.0', pendingAfterPlan: 7, sleep: noSleep };

describe('chunkPlan', () => {
  it('caps chunks at 500 rows with projects and sessions first', () => {
    const chunks = chunkPlan(plan(1200));
    expect(chunks.map((c) => c.buckets.length + c.sessions.length + c.projects.length)).toEqual([500, 500, 202]);
    expect(chunks[0]!.projects).toHaveLength(1);
    expect(chunks[0]!.sessions).toHaveLength(1);
    expect(chunks[2]!.sessions).toHaveLength(0);
  });
  it('returns nothing for an empty plan', () => {
    expect(chunkPlan({ buckets: [], sessions: [], projects: [], limitHits: [] })).toEqual([]);
  });
});

describe('postJson', () => {
  it('retries 5xx and network errors with backoff, then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const f = vi
      .fn<(u: string, i: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok());
    const r = await postJson('https://x.invalid/a', 't', {}, { fetch: f, sleep, baseDelayMs: 100 });
    expect(r.ok).toBe(true);
    expect(sleep.mock.calls.map((c) => (c as unknown as [number])[0])).toEqual([100, 200]);
  });

  it('stops immediately on 4xx with the server message', async () => {
    const f = vi.fn(async () => Response.json({ error: 'buckets[3].project: required' }, { status: 400 }));
    const r = await postJson('https://x.invalid/a', 't', {}, { fetch: f, sleep: noSleep });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, fatal: true, status: 400 });
    expect(!r.ok && r.error).toContain('buckets[3].project');
  });

  it('gives up after the attempt limit', async () => {
    const f = vi.fn(async () => new Response('', { status: 500 }));
    const r = await postJson('https://x.invalid/a', 't', {}, { fetch: f, sleep: noSleep, attempts: 3 });
    expect(f).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ ok: false, fatal: false });
  });
});

describe('uploadPlan', () => {
  it('sends valid chunks, acks each, and reports pending', async () => {
    const bodies: any[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.example.invalid/api/ingest/usage');
      bodies.push(JSON.parse(init.body as string));
      return ok();
    });
    const acked: number[] = [];
    const out = await uploadPlan(plan(600), { ...opts, fetch: f, stats: { outputIncomplete: 1 }, onChunkAcked: (c) => acked.push(c.buckets.length) });
    expect(out).toMatchObject({ chunksSent: 2, rowsSent: 602, rowsUnsent: 0, error: null });
    expect(acked).toEqual([498, 102]);
    expect(bodies.map((b) => b.pending)).toEqual([102 + 7, 7]);
    expect(bodies[0].stats).toBeUndefined();
    expect(bodies[1].stats).toEqual({ outputIncomplete: 1 });
    for (const b of bodies) expect(validateUsageIngest(b).ok).toBe(true);
  });

  it('stops after a rejected chunk; earlier chunks stay acked', async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 2 ? Response.json({ error: 'nope' }, { status: 401 }) : ok()));
    const acked = vi.fn();
    const out = await uploadPlan(plan(1200), { ...opts, fetch: f, onChunkAcked: acked });
    expect(acked).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ chunksSent: 1, rowsSent: 500, rowsUnsent: 702, fatal: true });
  });

  it('sends one empty heartbeat when there is nothing to upload', async () => {
    const f = vi.fn(async () => ok());
    const out = await uploadPlan({ buckets: [], sessions: [], projects: [], limitHits: [] }, { ...opts, fetch: f, onChunkAcked: () => {} });
    expect(f).toHaveBeenCalledTimes(1);
    expect(out.error).toBeNull();
  });

  it('halves a chunk on 413 and retries until it fits, keeping order and stats on the last request', async () => {
    const bodies: any[] = [];
    // Pretend the server accepts at most 100 rows per request.
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      const rows = b.buckets.length + (b.sessions?.length ?? 0) + (b.projects?.length ?? 0) + (b.limitHits?.length ?? 0);
      if (rows > 100) return Response.json({ error: 'payload too large' }, { status: 413 });
      bodies.push(b);
      return ok();
    });
    const acked: PlanRows[] = [];
    const out = await uploadPlan(plan(300), { ...opts, fetch: f, stats: { outputIncomplete: 2 }, onChunkAcked: (c) => acked.push(c) });
    expect(out).toMatchObject({ rowsSent: 302, rowsUnsent: 0, error: null, fatal: false });
    expect(acked.flatMap((c) => c.buckets.map((b) => b.hour))).toEqual(plan(300).buckets.map((b) => b.hour));
    expect(bodies[0].projects).toHaveLength(1);
    expect(bodies.filter((b) => b.stats)).toHaveLength(1);
    expect(bodies.at(-1).stats).toEqual({ outputIncomplete: 2 });
    expect(bodies.at(-1).pending).toBe(7);
  });

  it('skips a single row that is still too large and reports it without wedging the rest', async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      return b.buckets.some((x: HourlyBucket) => x.hour === bucket(3).hour) ? Response.json({ error: 'too large' }, { status: 413 }) : ok();
    });
    const acked: PlanRows[] = [];
    const out = await uploadPlan(plan(8), { ...opts, fetch: f, onChunkAcked: (c) => acked.push(c) });
    expect(out.rowsSent).toBe(9);
    expect(out.rowsUnsent).toBe(1);
    expect(out.fatal).toBe(false);
    expect(out.error).toContain('1 row(s) too large');
    expect(acked.flatMap((c) => c.buckets).some((b) => b.hour === bucket(3).hour)).toBe(false);
  });
});

describe('splitChunk', () => {
  it('splits into two halves in dependency order', () => {
    const parts = splitChunk(plan(5));
    expect(parts.map((c) => c.buckets.length + c.sessions.length + c.projects.length)).toEqual([4, 3]);
    expect(parts[0]!.projects).toHaveLength(1);
  });
});

describe('dropInvalidRows', () => {
  it('drops only the rows the shared validator rejects', () => {
    const p = plan(3);
    p.buckets[1] = { ...p.buckets[1]!, project: '' };
    p.sessions.push({ ...session, sessionId: 'x'.repeat(500) });
    const { plan: kept, rejected } = dropInvalidRows(p, { device: 'pc', version: '2.0.0' });
    expect(kept.buckets.map((b) => b.hour)).toEqual([bucket(0).hour, bucket(2).hour]);
    expect(kept.sessions).toEqual([session]);
    expect(kept.projects).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });
});
