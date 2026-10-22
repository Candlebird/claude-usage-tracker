import { env } from 'cloudflare:workers';
import {
  DAY,
  dayKey,
  HOUR,
  hourStartUtc,
  localToUnix,
  MINUTE,
  type HeatmapResponse,
  type LimitsResponse,
  type LiveResponse,
  type ModelsResponse,
  type ProjectsResponse,
  type SessionDetail,
  type SessionsResponse,
  type Settings,
  type SettingsResponse,
  type StatusResponse,
  type SummaryResponse,
  type TimeseriesResponse,
} from '@ccu/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as read from '../src/routes/read.js';
import { call, READ, WRITE } from './helpers.js';
import { body, clearTables, exec, invoke, seedSessions, seedUsage } from './read-seed.js';

const TZ = 'America/Denver';
/** 2027-01-15 14:10 local (21:10 UTC, MST = UTC-7). */
const NOW = localToUnix(2027, 1, 15, 14, 10, TZ);
const H = hourStartUtc(NOW);
const TODAY = localToUnix(2027, 1, 15, 0, 0, TZ);

beforeEach(async () => {
  vi.unstubAllGlobals();
  await clearTables();
});

describe('GET /api/summary', () => {
  it('rolls up periods, burn rate, limits and sync freshness', async () => {
    await seedUsage([
      { hour: H - HOUR, sessionId: 's-today-1', costUsd: 6, input: 100, cacheRead: 300, requests: 6 },
      { hour: H, sessionId: 's-today-2', costUsd: 1, output: 50, requests: 1 },
      { hour: TODAY - 3 * DAY + 10 * HOUR, sessionId: 's-3d', costUsd: 10, requests: 2 },
      { hour: TODAY - 20 * DAY + 10 * HOUR, sessionId: 's-20d', model: 'mystery-model-1', costUsd: 0, requests: 3 },
      { hour: TODAY - 40 * DAY, sessionId: 's-40d', costUsd: 999, requests: 9 },
      // 23:00 local yesterday: hour midpoint is yesterday, so not today.
      { hour: TODAY - HOUR, sessionId: 's-yday', costUsd: 2, requests: 1 },
    ]);
    await exec('INSERT INTO sync_runs (ts, device, rows, pending, version, errors) VALUES (?1, ?2, 5, 3, ?3, ?4)', NOW - 300, 'pc-1', '2.0.0', '[]');
    await exec(
      'INSERT INTO live_requests (request_id, ts, model, input, output, cost_usd) VALUES (?1, ?2, ?3, 10, 20, 0.5), (?4, ?5, ?3, 1, 1, 100)',
      'req-new',
      NOW - 60,
      'claude-sonnet-4-5',
      'req-old',
      NOW - 1000,
    );
    await exec(
      'INSERT INTO limit_snapshots (ts, window_key, utilization, resets_at, severity) VALUES (?1, ?2, 40, ?3, NULL), (?4, ?2, 20, ?3, NULL)',
      NOW - 120,
      'five_hour',
      NOW + 3 * HOUR,
      NOW - 3600,
    );

    const res = await invoke(read.summary, `/api/summary?tz=${TZ}`, { now: NOW });
    expect(res.status).toBe(200);
    const s = await body<SummaryResponse>(res);
    expect(s.tz).toBe(TZ);
    expect(s.today.costUsd).toBe(7);
    expect(s.today.sessions).toBe(2);
    expect(s.today.requests).toBe(7);
    expect(s.today.cacheHitRate).toBe(0.75);
    expect(s.today.cacheSavingsUsd).toBeGreaterThan(0);
    expect(s.last7d.costUsd).toBe(19);
    expect(s.last7d.sessions).toBe(4);
    expect(s.last30d.costUsd).toBe(19);
    expect(s.last30d.sessions).toBe(5);
    expect(s.unpricedModels).toEqual(['mystery-model-1']);
    expect(s.hasUnpriced).toBe(true);

    // Hourly: 50/60 of the 20:00 UTC bucket (5) + all of the synced 21:00-21:05 bucket (1); live after the sync cutoff: 0.5.
    expect(s.burnRate.costPerHour).toBeCloseTo(6.5, 6);
    expect(s.burnRate.source).toBe('merged');

    expect(s.limits).toHaveLength(1);
    expect(s.limits[0]!.key).toBe('five_hour');
    expect(s.limits[0]!.utilization).toBe(40);
    expect(s.limits[0]!.pace).not.toBeNull();
    expect(s.sync).toEqual({ lastSyncTs: NOW - 300, ageSeconds: 300, pending: 3, device: 'pc-1' });
    expect(s.dailyBudgetUsd).toBe(0);
  });

  it('works on an empty database', async () => {
    const s = await body<SummaryResponse>(await invoke(read.summary, '/api/summary', { now: NOW }));
    expect(s.today.costUsd).toBe(0);
    expect(s.burnRate.costPerHour).toBe(0);
    expect(s.limits).toEqual([]);
    expect(s.sync.lastSyncTs).toBeNull();
    expect(s.hasUnpriced).toBe(false);
  });
});

describe('GET /api/timeseries', () => {
  beforeEach(async () => {
    await seedUsage([
      { hour: TODAY + 9 * HOUR, model: 'claude-sonnet-4-5', project: 'proj-a', costUsd: 1, input: 10, output: 5, requests: 1 },
      { hour: TODAY + 10 * HOUR, model: 'claude-opus-4-5', project: 'proj-b', costUsd: 4, input: 20, output: 10, cacheRead: 100, requests: 2 },
      { hour: TODAY - DAY + 9 * HOUR, model: 'claude-sonnet-4-5', project: 'proj-a', agentKind: 'subagent', costUsd: 2, input: 1, requests: 1 },
    ]);
    await exec('INSERT INTO projects (project, label, path) VALUES (?1, ?2, NULL)', 'proj-b', 'Project B');
  });

  it('buckets by local day and zero-fills', async () => {
    const from = TODAY - 2 * DAY;
    const r = await body<TimeseriesResponse>(await invoke(read.timeseries, `/api/timeseries?from=${from}&to=${NOW}&tz=${TZ}`, { now: NOW }));
    expect(r.bucket).toBe('day');
    expect(r.metric).toBe('cost');
    const sonnet = r.series.find((s) => s.key === 'claude-sonnet-4-5')!;
    expect(sonnet.points).toEqual([
      [TODAY - 2 * DAY, 0],
      [TODAY - DAY, 2],
      [TODAY, 1],
    ]);
    expect(r.series[0]!.key).toBe('claude-opus-4-5');
  });

  it('groups by project with labels and filters by project', async () => {
    const q = `from=${TODAY}&to=${NOW}&tz=${TZ}&group=project&metric=tokens`;
    const r = await body<TimeseriesResponse>(await invoke(read.timeseries, `/api/timeseries?${q}`, { now: NOW }));
    const b = r.series.find((s) => s.key === 'proj-b')!;
    expect(b.label).toBe('Project B');
    expect(b.points[0]![1]).toBe(130);
    const only = await body<TimeseriesResponse>(await invoke(read.timeseries, `/api/timeseries?${q}&project=proj-a`, { now: NOW }));
    expect(only.series.map((s) => s.key)).toEqual(['proj-a']);
  });

  it('hour buckets and type grouping keep totals', async () => {
    const r = await body<TimeseriesResponse>(
      await invoke(read.timeseries, `/api/timeseries?from=${TODAY}&to=${NOW}&bucket=hour&group=type&metric=cost`, { now: NOW }),
    );
    expect(r.series[0]!.points[0]![0]).toBe(hourStartUtc(TODAY));
    expect(r.series[0]!.points).toHaveLength((H - TODAY) / HOUR + 1);
    const total = r.series.reduce((a, s) => a + s.points.reduce((b, p) => b + p[1], 0), 0);
    expect(total).toBeCloseTo(5, 5);
    const byKind = await body<TimeseriesResponse>(
      await invoke(read.timeseries, `/api/timeseries?from=${TODAY - DAY}&to=${NOW}&group=agent_kind&metric=requests&tz=${TZ}`, { now: NOW }),
    );
    expect(byKind.series.map((s) => s.key).sort()).toEqual(['main', 'subagent']);
  });

  it('rejects bad params over HTTP', async () => {
    expect((await call('/api/timeseries?group=nope', { token: READ })).status).toBe(400);
    expect((await call(`/api/timeseries?bucket=hour&from=${NOW - 90 * DAY}&to=${NOW}`, { token: READ })).status).toBe(400);
    expect((await call('/api/timeseries', { token: null })).status).toBe(401);
  });
});

describe('GET /api/limits', () => {
  it('returns history, hits and reconstructed 5-hour blocks', async () => {
    const reset = H + 2 * HOUR;
    await exec(
      `INSERT INTO limit_snapshots (ts, window_key, utilization, resets_at, severity) VALUES
        (?1, 'five_hour', 10, ?3, NULL), (?2, 'five_hour', 60, ?4, 'warning'), (?2, 'seven_day', 30, ?5, NULL)`,
      reset - 4 * HOUR,
      NOW - 60,
      reset,
      reset + 30,
      NOW + 3 * DAY,
    );
    await exec("INSERT INTO limit_hits (ts, kind, resets_at) VALUES (?1, 'five_hour', ?2)", NOW - 600, reset);
    await seedUsage([
      { hour: reset - 4 * HOUR, costUsd: 3, input: 100, requests: 3 },
      { hour: reset - 2 * HOUR, costUsd: 3, input: 50, requests: 1 },
      { hour: reset - 7 * HOUR, costUsd: 50, requests: 1 },
    ]);
    const r = await body<LimitsResponse>(await invoke(read.limits, `/api/limits?from=${NOW - DAY}&to=${NOW}`, { now: NOW }));
    expect(r.windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day']);
    expect(r.windows[0]!.points).toHaveLength(2);
    expect(r.hits).toEqual([{ ts: NOW - 600, kind: 'five_hour', resetsAt: reset }]);
    expect(r.blocks).toHaveLength(1);
    const b = r.blocks[0]!;
    expect(b.end).toBe(reset + 30);
    expect(b.start).toBe(reset + 30 - 5 * HOUR);
    expect(b.peakUtilization).toBe(60);
    expect(b.costUsd).toBe(6);
    expect(b.tokens).toBe(150);
    expect(b.costPerPercent).toBeCloseTo(0.1, 6);
    expect(b.active).toBe(true);
    expect(r.current.map((c) => c.key)).toEqual(['five_hour', 'seven_day']);
  });
});

describe('GET /api/projects and /api/models', () => {
  beforeEach(async () => {
    await seedUsage([
      { hour: TODAY + 9 * HOUR, project: 'proj-a', sessionId: 's1', model: 'claude-sonnet-4-5', costUsd: 1, input: 10, cacheRead: 30, requests: 1 },
      { hour: TODAY + 10 * HOUR, project: 'proj-a', sessionId: 's2', model: 'claude-opus-4-5', costUsd: 5, input: 10, requests: 1 },
      { hour: TODAY - DAY + 9 * HOUR, project: 'proj-b', sessionId: 's3', model: 'claude-sonnet-4-5', costUsd: 2, input: 40, requests: 2 },
    ]);
    await exec('INSERT INTO projects (project, label, path) VALUES (?1, ?2, ?3)', 'proj-a', 'Alpha', 'C:/synthetic/alpha');
  });

  it('projects: totals, sessions, top model, sparkline', async () => {
    const r = await body<ProjectsResponse>(await invoke(read.projects, `/api/projects?from=${TODAY - DAY}&to=${NOW}&tz=${TZ}`, { now: NOW }));
    expect(r.projects.map((p) => p.project)).toEqual(['proj-a', 'proj-b']);
    const a = r.projects[0]!;
    expect(a.label).toBe('Alpha');
    expect(a.path).toBe('C:/synthetic/alpha');
    expect(a.costUsd).toBe(6);
    expect(a.sessions).toBe(2);
    expect(a.topModel).toBe('claude-opus-4-5');
    expect(a.lastActive).toBe(TODAY + 11 * HOUR);
    expect(a.sparkline).toEqual([
      { day: dayKey(TODAY - DAY, TZ), costUsd: 0 },
      { day: dayKey(TODAY, TZ), costUsd: 6 },
    ]);
    expect(a.cacheHitRate).toBeCloseTo(30 / 50, 6);
    expect(r.projects[1]!.label).toBe('proj-b');
  });

  it('models: shares and pricing family', async () => {
    const r = await body<ModelsResponse>(await invoke(read.models, `/api/models?from=${TODAY - DAY}&to=${NOW}`, { now: NOW }));
    expect(r.models.map((m) => m.model)).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);
    expect(r.models.reduce((a, m) => a + m.costShare, 0)).toBeCloseTo(1, 9);
    expect(r.models[0]!.costShare).toBeCloseTo(5 / 8, 9);
    expect(r.models[1]!.tokenShare).toBeCloseTo(80 / 90, 9);
    expect(r.models[1]!.priced).toBe(true);
    expect(r.models[1]!.cacheSavingsUsd).toBeGreaterThan(0);
  });
});

describe('GET /api/sessions', () => {
  beforeEach(async () => {
    await seedSessions([
      { sessionId: 'sa', project: 'proj-a', title: 'Synthetic A', firstTs: NOW - 5 * HOUR, lastTs: NOW - 4 * HOUR, models: ['claude-sonnet-4-5'], costStateUsd: 1.5 },
      { sessionId: 'sb', project: 'proj-a', firstTs: NOW - 3 * HOUR, lastTs: NOW - 2 * HOUR, agentCount: 2 },
      { sessionId: 'sc', project: 'proj-b', firstTs: NOW - 2 * HOUR, lastTs: NOW - HOUR },
      { sessionId: 'old', project: 'proj-a', firstTs: NOW - 30 * DAY, lastTs: NOW - 29 * DAY },
    ]);
    await seedUsage([
      { hour: H - 5 * HOUR, sessionId: 'sa', costUsd: 1, input: 10, requests: 1 },
      { hour: H - 3 * HOUR, sessionId: 'sb', costUsd: 5, input: 10, requests: 1 },
      { hour: H - 2 * HOUR, sessionId: 'sb', model: 'claude-opus-4-5', costUsd: 1, input: 10, requests: 1 },
      { hour: H - 2 * HOUR, sessionId: 'sc', project: 'proj-b', costUsd: 2, input: 10, requests: 1 },
    ]);
  });

  it('sorts by recent (default) with total and paging', async () => {
    const r = await body<SessionsResponse>(await invoke(read.sessions, `/api/sessions?from=${NOW - DAY}&to=${NOW}&limit=2`, { now: NOW }));
    expect(r.total).toBe(3);
    expect(r.sort).toBe('recent');
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['sc', 'sb']);
    const p2 = await body<SessionsResponse>(await invoke(read.sessions, `/api/sessions?from=${NOW - DAY}&to=${NOW}&limit=2&offset=2`, { now: NOW }));
    expect(p2.sessions.map((s) => s.sessionId)).toEqual(['sa']);
    const a = p2.sessions[0]!;
    expect(a.title).toBe('Synthetic A');
    expect(a.costUsd).toBe(1);
    expect(a.untrackedOverheadUsd).toBe(0.5);
    expect(a.durationSeconds).toBe(HOUR);
    expect(a.models).toEqual(['claude-sonnet-4-5']);
  });

  it('hides untracked overhead while the latest sync still has buckets pending', async () => {
    const url = `/api/sessions?from=${NOW - DAY}&to=${NOW}&limit=3`;
    const overhead = async () => (await body<SessionsResponse>(await invoke(read.sessions, url, { now: NOW }))).sessions.find((s) => s.sessionId === 'sa')!.untrackedOverheadUsd;
    await exec("INSERT INTO sync_runs (ts, device, rows, pending, version) VALUES (?1, 'pc-1', 5, 40, '2.0.0')", NOW - 600);
    expect(await overhead()).toBeNull();
    const d = await body<SessionDetail>(await invoke(read.sessionDetail, '/api/sessions/sa', { now: NOW, params: { id: 'sa' } }));
    expect(d.session.untrackedOverheadUsd).toBeNull();
    await exec("INSERT INTO sync_runs (ts, device, rows, pending, version) VALUES (?1, 'pc-1', 40, 0, '2.0.0')", NOW - 300);
    expect(await overhead()).toBe(0.5);
  });

  it('sorts by cost and filters by project', async () => {
    const r = await body<SessionsResponse>(await invoke(read.sessions, `/api/sessions?from=${NOW - DAY}&to=${NOW}&sort=cost`, { now: NOW }));
    expect(r.sessions.map((s) => [s.sessionId, s.costUsd])).toEqual([
      ['sb', 6],
      ['sc', 2],
      ['sa', 1],
    ]);
    expect(r.sessions[0]!.untrackedOverheadUsd).toBeNull();
    expect(r.sessions[0]!.agentCount).toBe(2);
    const b = await body<SessionsResponse>(await invoke(read.sessions, `/api/sessions?from=${NOW - DAY}&to=${NOW}&sort=cost&project=proj-b`, { now: NOW }));
    expect(b.total).toBe(1);
    expect(b.sessions[0]!.sessionId).toBe('sc');
  });

  it('detail: hourly series and totals; synthesized meta; 404', async () => {
    const d = await body<SessionDetail>(await invoke(read.sessionDetail, '/api/sessions/sb', { now: NOW, params: { id: 'sb' } }));
    expect(d.session.sessionId).toBe('sb');
    expect(d.session.costUsd).toBe(6);
    expect(d.totals.all.requests).toBe(2);
    expect(d.totals.byModel.map((m) => m.key)).toEqual(['claude-sonnet-4-5', 'claude-opus-4-5']);
    expect(d.byModel[0]!.points).toEqual([
      [H - 3 * HOUR, 5],
      [H - 2 * HOUR, 0],
    ]);
    expect(d.byAgentKind.map((s) => s.key)).toEqual(['main']);

    await seedUsage([{ hour: H, sessionId: 'no-meta', project: 'proj-z', costUsd: 1, requests: 1 }]);
    const n = await body<SessionDetail>(await invoke(read.sessionDetail, '/api/sessions/no-meta', { now: NOW, params: { id: 'no-meta' } }));
    expect(n.session.project).toBe('proj-z');
    expect(n.session.firstTs).toBe(H);

    expect((await call('/api/sessions/missing-session', { token: READ })).status).toBe(404);
  });
});

describe('GET /api/heatmap', () => {
  it('builds a sparse dow x hour grid and a zero-filled calendar with legacy fill', async () => {
    // 2027-01-15 is a Friday (dow 5). 09:00 local = 16:00 UTC.
    await seedUsage([{ hour: TODAY + 9 * HOUR, costUsd: 2, input: 10, output: 5, requests: 3 }]);
    const legacyDay = dayKey(TODAY - 3 * DAY, TZ);
    await exec("INSERT INTO daily_legacy (day, model, tokens, requests) VALUES (?1, 'claude-sonnet-4', 500, 4)", legacyDay);
    const r = await body<HeatmapResponse>(await invoke(read.heatmap, `/api/heatmap?weeks=1&tz=${TZ}`, { now: NOW }));
    expect(r.weeks).toBe(1);
    expect(r.calendar).toHaveLength(7);
    expect(r.calendar[6]).toEqual({ day: dayKey(NOW, TZ), costUsd: 2, tokens: 15, requests: 3 });
    expect(r.calendar.find((c) => c.day === legacyDay)).toEqual({ day: legacyDay, costUsd: 0, tokens: 500, requests: 4 });
    expect(r.grid).toEqual([{ dow: 5, hour: 9, costUsd: 2, tokens: 15, requests: 3 }]);
    expect(r.from).toBe(TODAY - 6 * DAY);
  });
});

describe('GET /api/live', () => {
  it('returns a zero-filled per-minute series and recent requests', async () => {
    await exec(
      `INSERT INTO live_requests (request_id, ts, session_id, model, input, output, cost_usd) VALUES
        ('r1', ?1, 'sx', 'claude-sonnet-4-5', 10, 5, 0.25), ('r2', ?2, 'sx', 'claude-sonnet-4-5', 1, 1, 0.5), ('r3', ?3, NULL, NULL, NULL, NULL, NULL)`,
      NOW - 2 * MINUTE,
      NOW - 2 * MINUTE + 1,
      NOW - 10 * MINUTE,
    );
    const r = await body<LiveResponse>(await invoke(read.live, '/api/live?minutes=5', { now: NOW }));
    expect(r.perMinute).toHaveLength(5);
    const m = r.perMinute.find((p) => p.t === NOW - 2 * MINUTE)!;
    expect(m).toEqual({ t: NOW - 2 * MINUTE, requests: 2, costUsd: 0.75, tokens: 17 });
    expect(r.recent.map((x) => x.requestId)).toEqual(['r2', 'r1', 'r3']);
    expect(r.recent[0]!.cacheRead).toBeNull();
    expect(r.lastReceivedTs).toBe(NOW - 2 * MINUTE + 1);
  });
});

describe('GET /api/status', () => {
  it('reports sync runs, row counts, unpriced models and rows written today', async () => {
    await exec(
      "INSERT INTO sync_runs (ts, device, rows, pending, version, errors) VALUES (?1, 'pc-1', 100, 0, '2.0.0', ?2), (?3, 'pc-1', 50, 2, '2.0.0', NULL), (?4, 'pc-1', 999, 0, '2.0.0', NULL)",
      NOW - 300,
      JSON.stringify(['synthetic error']),
      NOW - 600,
      NOW - 2 * DAY,
    );
    await exec("INSERT INTO live_requests (request_id, ts, model) VALUES ('l1', ?1, 'mystery-live-model'), ('l2', ?2, 'claude-sonnet-4-5')", NOW - 60, NOW - 120);
    await exec("INSERT INTO limit_snapshots (ts, window_key, utilization, resets_at) VALUES (?1, 'five_hour', 5, ?2)", NOW - 60, NOW + HOUR);
    await exec("INSERT INTO settings (key, value) VALUES ('meta.syncStats', ?1)", JSON.stringify({ ts: NOW - 300, outputIncomplete: 4, unpricedModels: ['mystery-sync-model'] }));

    const r = await body<StatusResponse>(await invoke(read.status, '/api/status', { now: NOW }));
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.syncRuns.map((s) => s.ts)).toEqual([NOW - 300, NOW - 600, NOW - 2 * DAY]);
    expect(r.syncRuns[0]!.errors).toEqual(['synthetic error']);
    expect(r.syncRuns[1]!.errors).toEqual([]);
    expect(r.tableRows.sync_runs).toBe(3);
    expect(r.tableRows.live_requests).toBe(2);
    expect(r.unpricedModels).toEqual(['mystery-live-model', 'mystery-sync-model']);
    expect(r.otelLastReceivedTs).toBe(NOW - 60);
    expect(r.outputIncomplete).toEqual({ requests: 4, reportedTs: NOW - 300 });
    // 2*150 synced rows + 2 runs + 3*2 live + 1 snapshot
    expect(r.d1RowsWrittenToday).toBe(309);
    expect(r.freeTier.rowsWrittenPerDay).toBe(100000);

    // Row counts are cached for a while.
    await exec("INSERT INTO projects (project, label) VALUES ('p-new', 'P')");
    const again = await body<StatusResponse>(await invoke(read.status, '/api/status', { now: NOW + 60 }));
    expect(again.tableRows.projects).toBe(0);
    const later = await body<StatusResponse>(await invoke(read.status, '/api/status', { now: NOW + 7 * HOUR }));
    expect(later.tableRows.projects).toBe(1);
  });
});

describe('settings and alerts/test', () => {
  it('GET returns defaults, PUT validates and merges', async () => {
    const d = await body<Settings>(await call('/api/settings', { token: READ }));
    expect(d.staleSyncMinutes).toBe(60);
    const put = await call('/api/settings', { method: 'PUT', token: READ, body: JSON.stringify({ dailyBudgetUsd: 25, alertThresholds: { fiveHour: [90, 50], weekly: [80] } }) });
    expect(put.status).toBe(200);
    const s = await body<Settings>(put);
    expect(s.dailyBudgetUsd).toBe(25);
    expect(s.alertThresholds.fiveHour).toEqual([50, 90]);
    expect(s.ntfyEnabled).toBe(true);
    expect((await body<Settings>(await call('/api/settings', { token: WRITE }))).dailyBudgetUsd).toBe(25);
    expect((await call('/api/settings', { method: 'PUT', token: READ, body: JSON.stringify({ dailyBudgetUsd: -1 }) })).status).toBe(400);
    expect((await call('/api/settings', { method: 'PUT', token: READ, body: '{not json' })).status).toBe(400);
  });

  it('reports whether an ntfy topic is configured without revealing it', async () => {
    const withTopic = await body<SettingsResponse>(await invoke(read.getSettings, '/api/settings', { now: NOW, env: { NTFY_TOPIC: 'synthetic-test-topic' } }));
    expect(withTopic.ntfyConfigured).toBe(true);
    expect(JSON.stringify(withTopic)).not.toContain('synthetic-test-topic');
    const without = await body<SettingsResponse>(await invoke(read.getSettings, '/api/settings', { now: NOW, env: { NTFY_TOPIC: '' } }));
    expect(without.ntfyConfigured).toBe(false);
  });

  it('alerts/test sends a push when a topic is configured', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await body<{ ok: boolean; sent: boolean }>(
      await invoke(read.alertsTest, '/api/alerts/test', { now: NOW, init: { method: 'POST' }, env: { NTFY_TOPIC: 'synthetic-test-topic', NTFY_SERVER: 'https://ntfy.test' } }),
    );
    expect(ok).toEqual({ ok: true, sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://ntfy.test/synthetic-test-topic');

    const none = await body<{ ok: boolean; sent: boolean; error?: string }>(
      await invoke(read.alertsTest, '/api/alerts/test', { now: NOW, init: { method: 'POST' }, env: { NTFY_TOPIC: '' } }),
    );
    expect(none.sent).toBe(false);
    expect(none.error).toBeTruthy();
  });

  it('alerts/test is rate limited per configured topic', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const send = (now: number) =>
      invoke(read.alertsTest, '/api/alerts/test', { now, init: { method: 'POST' }, env: { NTFY_TOPIC: 'synthetic-test-topic', NTFY_SERVER: 'https://ntfy.test' } });
    expect((await send(NOW)).status).toBe(200);
    await expect(send(NOW + read.ALERT_TEST_COOLDOWN - 1)).rejects.toMatchObject({ status: 429, message: 'test alert rate limited; retry in 1s' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await send(NOW + read.ALERT_TEST_COOLDOWN)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('settings in env do not leak', () => {
    expect(env.READ_TOKEN).toBe(READ);
  });
});
