import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getMeta, META_SYNC_STATS, type SyncStatsMeta } from '../src/db.js';
import { SUPERSEDED_UNKNOWN_HITS_SQL } from '../src/upserts.js';
import { apiError, apiRequest, bucket, HOUR0, otlpPayload, T_NANOS, usageIngest } from './fixtures.js';
import { call, post, WRITE } from './helpers.js';

const TABLES = ['usage_hourly', 'sessions', 'projects', 'limit_snapshots', 'limit_hits', 'live_requests', 'daily_legacy', 'sync_runs', 'settings'];

async function count(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return r?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe('POST /api/ingest/usage', () => {
  it('upserts idempotently and replaces values', async () => {
    const first = await post('/api/ingest/usage', usageIngest());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, accepted: { buckets: 2, sessions: 0, projects: 0, limitHits: 0 } });
    expect(await count('usage_hourly')).toBe(2);

    const again = usageIngest({ buckets: [bucket(0, { output: 999, costUsd: 1.25 }), bucket(1)] });
    expect((await post('/api/ingest/usage', again)).status).toBe(200);
    expect(await count('usage_hourly')).toBe(2);
    const row = await env.DB.prepare('SELECT output, cost_usd, device FROM usage_hourly WHERE session_id = ?').bind('sess-0').first();
    expect(row).toEqual({ output: 999, cost_usd: 1.25, device: 'test-device' });
  });

  it('merges sessions without losing known fields', async () => {
    const s = { sessionId: 'sess-m', project: 'c:/synthetic/a', title: 'Synthetic title', gitBranch: 'main', firstTs: HOUR0, lastTs: HOUR0 + 60, models: ['m1'], agentCount: 1, linesAdded: 5 };
    await post('/api/ingest/usage', usageIngest({ buckets: [], sessions: [s], projects: [{ project: 'c:/synthetic/a', label: 'a', path: 'C:\\synthetic\\a' }] }));
    const later = { sessionId: 'sess-m', project: 'c:/synthetic/a', firstTs: HOUR0 + 30, lastTs: HOUR0 + 600, models: ['m1', 'm2'], agentCount: 2 };
    await post('/api/ingest/usage', usageIngest({ buckets: [], sessions: [later], projects: [{ project: 'c:/synthetic/a', label: 'A' }] }));

    const row = await env.DB.prepare('SELECT * FROM sessions WHERE session_id = ?').bind('sess-m').first();
    expect(row).toMatchObject({ title: 'Synthetic title', git_branch: 'main', first_ts: HOUR0, last_ts: HOUR0 + 600, models: '["m1","m2"]', agent_count: 2, lines_added: 5 });
    const proj = await env.DB.prepare('SELECT label, path FROM projects').first();
    expect(proj).toEqual({ label: 'A', path: 'C:\\synthetic\\a' });
  });

  it('records the sync run and sync stats', async () => {
    const body = usageIngest({ pending: 3, limitHits: [{ ts: HOUR0, kind: 'five_hour', resetsAt: HOUR0 + 3600 }], stats: { outputIncomplete: 4, unpricedModels: ['mystery-model'], errors: ['synthetic failure'] } });
    expect((await post('/api/ingest/usage', body)).status).toBe(200);
    const run = await env.DB.prepare('SELECT device, rows, pending, version, errors FROM sync_runs').first();
    expect(run).toEqual({ device: 'test-device', rows: 3, pending: 3, version: '2.0.0-test', errors: '["synthetic failure"]' });
    const meta = await getMeta<SyncStatsMeta>(env.DB, META_SYNC_STATS);
    expect(meta).toMatchObject({ outputIncomplete: 4, unpricedModels: ['mystery-model'] });
    expect(await count('limit_hits')).toBe(1);
  });

  it('answers 400 for invalid payloads', async () => {
    const res = await post('/api/ingest/usage', usageIngest({ buckets: [bucket(0, { hour: HOUR0 + 1 })] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('3600');
    const bad = await call('/api/ingest/usage', { method: 'POST', body: '{nope', token: WRITE });
    expect(bad.status).toBe(400);
    expect(await count('usage_hourly')).toBe(0);
  });

  it('answers 413 when a chunk needs too many statements', async () => {
    const buckets = Array.from({ length: 1000 }, (_, i) => bucket(i, { project: `c:/synthetic/p${i}`, model: `model-${i}` }));
    const sessions = Array.from({ length: 1000 }, (_, i) => ({ sessionId: `s-${i}`, project: `c:/synthetic/q${i}`, firstTs: HOUR0, lastTs: HOUR0, models: [`x${i}`], agentCount: 0 }));
    const res = await post('/api/ingest/usage', usageIngest({ buckets, sessions }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain('smaller chunks');
    expect(await count('usage_hourly')).toBe(0);
  });

  it('accepts a full 500-row chunk', async () => {
    const buckets = Array.from({ length: 500 }, (_, i) => bucket(i));
    expect((await post('/api/ingest/usage', usageIngest({ buckets }))).status).toBe(200);
    expect(await count('usage_hourly')).toBe(500);
  });

  it('refuses bodies over 1 MB', async () => {
    const res = await call('/api/ingest/usage', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }), token: WRITE });
    expect(res.status).toBe(413);
  });
});

describe('POST /api/ingest/limits', () => {
  const snap = (ts: number, utilization: number) => ({
    ts,
    windows: [
      { key: 'five_hour', label: '5-hour', utilization, resetsAt: '2027-01-15T10:00:29.5Z' },
    ],
  });

  it('stores one row per window and snapshot, idempotently', async () => {
    const res = await post('/api/ingest/limits', { snapshots: [snap(HOUR0, 40), snap(HOUR0 + 300, 42)] });
    expect(res.status).toBe(200);
    await post('/api/ingest/limits', { snapshots: [snap(HOUR0, 41)] });
    const rows = await env.DB.prepare('SELECT ts, window_key, utilization, resets_at FROM limit_snapshots ORDER BY ts').all();
    expect(rows.results).toEqual([
      { ts: HOUR0, window_key: 'five_hour', utilization: 41, resets_at: Math.round(Date.parse('2027-01-15T10:00:29.5Z') / 60000) * 60 },
      { ts: HOUR0 + 300, window_key: 'five_hour', utilization: 42, resets_at: Math.round(Date.parse('2027-01-15T10:00:29.5Z') / 60000) * 60 },
    ]);
  });

  it('stores valid snapshots', async () => {
    const body = { snapshots: [{ ts: HOUR0, windows: [{ key: 'seven_day', utilization: 12.5, resetsAt: '2027-01-20T00:00:00Z', severity: 'ok' }] }] };
    const res = await post('/api/ingest/limits', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: { snapshots: 1, windows: 1 } });
    expect(await count('limit_snapshots')).toBe(1);
  });
});

describe('POST /api/ingest/daily-legacy', () => {
  it('upserts days', async () => {
    const days = [{ day: '2026-01-02', model: 'm', tokens: 10, requests: 1 }, { day: '2026-01-03', model: 'm', tokens: 20, requests: 2 }];
    expect((await post('/api/ingest/daily-legacy', { days })).status).toBe(200);
    expect((await post('/api/ingest/daily-legacy', { days: [{ ...days[0], tokens: 11 }] })).status).toBe(200);
    const rows = await env.DB.prepare('SELECT day, tokens FROM daily_legacy ORDER BY day').all();
    expect(rows.results).toEqual([{ day: '2026-01-02', tokens: 11 }, { day: '2026-01-03', tokens: 20 }]);
    expect((await post('/api/ingest/daily-legacy', { days: [{ day: '2026-13-01', model: 'm', tokens: 1, requests: 1 }] })).status).toBe(400);
  });
});

describe('POST /v1/logs', () => {
  it('stores api_request events and 429s, ignoring re-sends', async () => {
    const body = otlpPayload([apiRequest(), apiRequest({ request_id: 'req_synthetic_2' }), apiError(429, T_NANOS)]);
    const res = await post('/v1/logs', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });
    expect((await post('/v1/logs', body)).status).toBe(200);
    expect(await count('live_requests')).toBe(2);
    const row = await env.DB.prepare('SELECT * FROM live_requests WHERE request_id = ?').bind('req_synthetic_1').first();
    expect(row).toMatchObject({ ts: 1_800_000_123, cache_write_5m: 100, cache_write_1h: 200, cost_usd: 0.0123, query_source: 'repl_main_thread' });
    expect(await env.DB.prepare('SELECT ts, kind FROM limit_hits').all().then((r) => r.results)).toEqual([{ ts: 1_800_000_120, kind: 'unknown' }]);
  });

  it('keeps one row per 429 whichever of OTLP and sync arrives first', async () => {
    const hits = async () => env.DB.prepare('SELECT ts, kind FROM limit_hits ORDER BY ts').all().then((r) => r.results);
    const typed = { ts: 1_800_000_150, kind: 'five_hour', resetsAt: 1_800_003_600 };
    // OTLP first, then sync's typed hit supersedes the unknown row.
    await post('/v1/logs', otlpPayload([apiError(429, T_NANOS)]));
    expect((await post('/api/ingest/usage', usageIngest({ limitHits: [typed] }))).status).toBe(200);
    expect(await hits()).toEqual([{ ts: typed.ts, kind: 'five_hour' }]);
    // Sync first: a late OTLP re-send of the same 429 is dropped again.
    await post('/v1/logs', otlpPayload([apiError(429, T_NANOS)]));
    expect(await hits()).toEqual([{ ts: typed.ts, kind: 'five_hour' }]);
    // A 429 far from any typed hit stays.
    await post('/v1/logs', otlpPayload([apiError(429, '1800003000000000000')]));
    expect(await hits()).toEqual([{ ts: typed.ts, kind: 'five_hour' }, { ts: 1_800_003_000, kind: 'unknown' }]);
  });

  it('cleans superseded hits with an indexed range scan', async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${SUPERSEDED_UNKNOWN_HITS_SQL}`).bind(1, 2).all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail);
    expect(details.length).toBeGreaterThan(0);
    expect(details.filter((d) => /^SCAN limit_hits/.test(d))).toEqual([]);
  });

  it('reports malformed records as rejected', async () => {
    const bad = { body: { stringValue: 'claude_code.api_request' }, attributes: [] };
    const res = await post('/v1/logs', otlpPayload([apiRequest(), bad]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partialSuccess: { rejectedLogRecords: '1' } });
    expect(await count('live_requests')).toBe(1);
  });

  it('accepts gzip bodies', async () => {
    const raw = new Blob([JSON.stringify(otlpPayload([apiRequest()]))]).stream().pipeThrough(new CompressionStream('gzip'));
    const gz = await new Response(raw).arrayBuffer();
    const res = await call('/v1/logs', { method: 'POST', body: gz, token: WRITE, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(await count('live_requests')).toBe(1);
  });

  it('refuses protobuf and unknown encodings with 415', async () => {
    const pb = await call('/v1/logs', { method: 'POST', body: 'x', token: WRITE, headers: { 'Content-Type': 'application/x-protobuf' } });
    expect(pb.status).toBe(415);
    const br = await call('/v1/logs', { method: 'POST', body: '{}', token: WRITE, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' } });
    expect(br.status).toBe(415);
  });

  it('refuses bodies over 256 KB', async () => {
    const res = await call('/v1/logs', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(300 * 1024) }), token: WRITE });
    expect(res.status).toBe(413);
  });

  it('acknowledges metrics without storing them', async () => {
    const res = await post('/v1/metrics', { resourceMetrics: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
