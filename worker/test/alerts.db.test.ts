import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DAY, HOUR, localToUnix, MINUTE } from '@ccu/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateAfterLimits, loadTodayCost, loadWindows, runAlerts, sendNtfy, type AlertEnv } from '../src/alerts.js';
import worker from '../src/index.js';
import { buildSummary } from '../src/routes/read-summary.js';

const TZ = 'America/Denver';
/** 2027-01-15 14:10 local: mid-hour (no pruning), waking hours. */
const NOW = localToUnix(2027, 1, 15, 14, 10, TZ);
const TOPIC = 'synthetic-test-topic';

const alertEnv = (over: Partial<AlertEnv> = {}): AlertEnv => ({
  ...env,
  TZ_NAME: TZ,
  NTFY_TOPIC: TOPIC,
  NTFY_SERVER: 'https://ntfy.test',
  DAILY_BUDGET_USD: '0',
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await env.DB.batch(
    ['limit_snapshots', 'limit_hits', 'alert_state', 'sync_runs', 'usage_hourly', 'settings'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function snap(key: string, ts: number, utilization: number, resetsAt: number) {
  return env.DB.prepare('INSERT INTO limit_snapshots (ts, window_key, utilization, resets_at) VALUES (?, ?, ?, ?)').bind(ts, key, utilization, resetsAt);
}

function syncRun(ts: number) {
  return env.DB.prepare('INSERT INTO sync_runs (ts, device, rows, pending) VALUES (?, ?, 0, 0)').bind(ts, 'test-device');
}

function usage(hour: number, cost: number) {
  return env.DB.prepare(
    `INSERT INTO usage_hourly (hour, project, model, agent_kind, session_id, requests, input, output, cache_read,
       cache_write_5m, cache_write_1h, web_search, cost_usd) VALUES (?, 'p', 'm', 'main', 's', 1, 0, 0, 0, 0, 0, 0, ?)`,
  ).bind(hour, cost);
}

function sentTitles(): string[] {
  return fetchMock.mock.calls.map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers.Title!);
}

async function firedKeys(): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT alert_key FROM alert_state ORDER BY alert_key').all<{ alert_key: string }>();
  return rows.results.map((r) => r.alert_key);
}

describe('sendNtfy', () => {
  it('posts to server/topic with ntfy headers', async () => {
    const res = await sendNtfy(alertEnv(), { title: 'T', message: 'body', priority: 'high', tags: ['warning', 'x'], click: 'https://dash.example/#/limits' });
    expect(res).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://ntfy.test/${TOPIC}`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('body');
    expect(init.headers).toMatchObject({ Title: 'T', Priority: 'high', Tags: 'warning,x', Click: 'https://dash.example/#/limits' });
  });

  it('is a no-op without a topic', async () => {
    expect((await sendNtfy(alertEnv({ NTFY_TOPIC: undefined }), { title: 'T', message: 'm', priority: 'default', tags: [] })).sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports HTTP and network failures without throwing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    expect(await sendNtfy(alertEnv(), { title: 'T', message: 'm', priority: 'default', tags: [] })).toEqual({ sent: false, error: 'ntfy responded 500' });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await sendNtfy(alertEnv(), { title: 'T', message: 'm', priority: 'default', tags: [] })).toEqual({ sent: false, error: 'offline' });
  });
});

describe('loadWindows', () => {
  it('returns the latest snapshot per window and drops reset windows', async () => {
    await env.DB.batch([
      snap('five_hour', NOW - 900, 10, NOW + HOUR),
      snap('five_hour', NOW - 300, 20, NOW + HOUR),
      snap('seven_day', NOW - 600, 30, NOW + 3 * DAY),
      snap('seven_day:fable', NOW - 600, 40, NOW + 3 * DAY),
      snap('seven_day:old', NOW - 2 * DAY, 50, NOW - DAY),
    ]);
    const out = await loadWindows(env.DB, NOW);
    expect(out.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'five_hour', ts: NOW - 300, utilization: 20, resetsAt: NOW + HOUR },
      { key: 'seven_day', ts: NOW - 600, utilization: 30, resetsAt: NOW + 3 * DAY },
      { key: 'seven_day:fable', ts: NOW - 600, utilization: 40, resetsAt: NOW + 3 * DAY },
    ]);
  });

  it('handles an empty table', async () => {
    expect(await loadWindows(env.DB, NOW)).toEqual([]);
  });
});

describe('runAlerts', () => {
  it('does nothing (and no queries matter) when no topic is set', async () => {
    await env.DB.batch([snap('five_hour', NOW - 60, 95, NOW + HOUR)]);
    expect((await runAlerts(alertEnv({ NTFY_TOPIC: undefined }), NOW)).sent).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when ntfy is disabled in settings', async () => {
    await env.DB.batch([snap('five_hour', NOW - 60, 95, NOW + HOUR), env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ntfyEnabled', 'false')")]);
    await runAlerts(alertEnv(), NOW);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fires a threshold alert once per window reset', async () => {
    await env.DB.batch([snap('five_hour', NOW - 60, 92, NOW + HOUR), syncRun(NOW - 60)]);
    const first = await runAlerts(alertEnv(), NOW);
    expect(first.sent.map((a) => a.rule)).toEqual(['threshold']);
    expect(sentTitles()).toEqual(['5-hour session limit at 92%']);
    expect(fetchMock.mock.calls[0]![1].headers.Priority).toBe('high');
    expect(await firedKeys()).toEqual([`threshold:five_hour:75:${NOW + HOUR}`, `threshold:five_hour:90:${NOW + HOUR}`]);

    // Same window: deduped.
    await runAlerts(alertEnv(), NOW + 5 * MINUTE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Next block resets: fires again.
    const reset2 = NOW + 6 * HOUR;
    await env.DB.batch([snap('five_hour', NOW + 2 * HOUR, 80, reset2), syncRun(NOW + 2 * HOUR)]);
    await runAlerts(alertEnv(), NOW + 2 * HOUR);
    expect(sentTitles()[1]).toBe('5-hour session limit at 80%');
  });

  it('escalates from a lower to a higher threshold in the same window', async () => {
    await env.DB.batch([snap('five_hour', NOW - 60, 80, NOW + HOUR), syncRun(NOW)]);
    await runAlerts(alertEnv(), NOW);
    await runAlerts(alertEnv(), NOW + 60);
    await env.DB.batch([snap('five_hour', NOW + 120, 91, NOW + HOUR)]);
    await runAlerts(alertEnv(), NOW + 180);
    expect(sentTitles()).toEqual(['5-hour session limit at 80%', '5-hour session limit at 91%']);
  });

  it('does not record an alert whose send failed, so it retries', async () => {
    await env.DB.batch([snap('five_hour', NOW - 60, 80, NOW + HOUR), syncRun(NOW)]);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    expect((await runAlerts(alertEnv(), NOW)).sent).toEqual([]);
    expect(await firedKeys()).toEqual([]);
    expect((await runAlerts(alertEnv(), NOW + 300)).sent).toHaveLength(1);
  });

  it('fires the daily budget alert from usage_hourly using settings over the env default', async () => {
    const dayStartLocal = localToUnix(2027, 1, 15, 0, 0, TZ);
    await env.DB.batch([
      usage(dayStartLocal - HOUR, 100), // yesterday: excluded
      usage(dayStartLocal, 6),
      usage(dayStartLocal + 10 * HOUR, 5),
      syncRun(NOW),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('dailyBudgetUsd', '10')"),
    ]);
    const res = await runAlerts(alertEnv({ DAILY_BUDGET_USD: '0' }), NOW);
    expect(res.sent.map((a) => a.key)).toEqual(['budget:2027-01-15']);
    expect(sentTitles()).toEqual(['Daily budget reached: $11.00']);
    await runAlerts(alertEnv(), NOW + 300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("agrees with the dashboard's today cost in fractional-offset timezones", async () => {
    const hour0 = NOW - (NOW % HOUR);
    // One bucket per hour across the last 30 h, each costing 2^k so every boundary choice gives a distinct sum.
    await env.DB.batch(Array.from({ length: 30 }, (_, k) => usage(hour0 - k * HOUR, 2 ** k)));
    for (const tz of ['America/Denver', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Eucla', 'America/St_Johns']) {
      const summary = await buildSummary(env, tz, NOW);
      expect(await loadTodayCost(env.DB, NOW, tz), tz).toBeCloseTo(summary.today.costUsd, 6);
    }
  });

  it('uses DAILY_BUDGET_USD when no setting is stored', async () => {
    const dayStartLocal = localToUnix(2027, 1, 15, 0, 0, TZ);
    await env.DB.batch([usage(dayStartLocal + HOUR, 3), syncRun(NOW)]);
    expect((await runAlerts(alertEnv({ DAILY_BUDGET_USD: '5' }), NOW)).sent).toEqual([]);
    expect((await runAlerts(alertEnv({ DAILY_BUDGET_USD: '2.5' }), NOW)).sent.map((a) => a.rule)).toEqual(['budget']);
  });

  it('fires stale sync once per stall, only in waking hours', async () => {
    const night = localToUnix(2027, 1, 15, 2, 10, TZ);
    await env.DB.batch([syncRun(night - 3 * HOUR)]);
    await runAlerts(alertEnv(), night);
    expect(fetchMock).not.toHaveBeenCalled();

    await env.DB.batch([syncRun(NOW - 2 * HOUR)]);
    await runAlerts(alertEnv(), NOW);
    await runAlerts(alertEnv(), NOW + 300);
    expect(sentTitles()).toEqual(['Usage sync is stale']);
  });

  it('alerts on a new limit hit once, ignoring old ones', async () => {
    await env.DB.batch([
      syncRun(NOW),
      env.DB.prepare('INSERT INTO limit_hits (ts, kind, resets_at) VALUES (?, ?, ?)').bind(NOW - 5 * HOUR, 'five_hour', NOW - HOUR),
      env.DB.prepare('INSERT INTO limit_hits (ts, kind, resets_at) VALUES (?, ?, ?)').bind(NOW - 120, 'seven_day', NOW + 2 * DAY),
      env.DB.prepare('INSERT INTO limit_hits (ts, kind, resets_at) VALUES (?, ?, ?)').bind(NOW - 60, 'seven_day', NOW + 2 * DAY),
    ]);
    const res = await runAlerts(alertEnv(), NOW);
    expect(res.sent.map((a) => a.key)).toEqual([`hit:seven_day:${NOW + 2 * DAY}`]);
    expect(fetchMock.mock.calls[0]![1].headers.Priority).toBe('urgent');
    await runAlerts(alertEnv(), NOW + 300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps sends per run and passes DASHBOARD_URL as Click', async () => {
    const stmts = Array.from({ length: 8 }, (_, i) => snap(`seven_day:m${i}`, NOW - 60, 95, NOW + 3 * DAY));
    await env.DB.batch([...stmts, syncRun(NOW)]);
    const res = await runAlerts(alertEnv({ DASHBOARD_URL: 'https://dash.example/' }), NOW);
    expect(res.evaluated).toBeGreaterThan(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0]![1].headers.Click).toBe('https://dash.example/');
    // The rest go out on the next tick.
    await runAlerts(alertEnv(), NOW + 300);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
  });

  it('prunes old alert_state rows at the top of the hour only', async () => {
    const top = Math.floor(NOW / HOUR) * HOUR + 60;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO alert_state (alert_key, fired_at) VALUES (?, ?)').bind('old', top - 31 * DAY),
      env.DB.prepare('INSERT INTO alert_state (alert_key, fired_at) VALUES (?, ?)').bind('recent', top - DAY),
    ]);
    await runAlerts(alertEnv(), top + 10 * MINUTE);
    expect(await firedKeys()).toEqual(['old', 'recent']);
    await runAlerts(alertEnv({ NTFY_TOPIC: undefined }), top);
    expect(await firedKeys()).toEqual(['recent']);
  });
});

describe('evaluateAfterLimits', () => {
  it('runs only limit-window rules', async () => {
    await env.DB.batch([
      snap('seven_day', NOW - 60, 60, NOW + 3 * DAY), // pace 60% / (4/7) = 1.05: no pace alert; no threshold
      snap('five_hour', NOW - 60, 76, NOW + HOUR),
      syncRun(NOW - 5 * HOUR), // stale, but not evaluated here
      env.DB.prepare('INSERT INTO limit_hits (ts, kind) VALUES (?, ?)').bind(NOW - 60, 'five_hour'),
    ]);
    const res = await evaluateAfterLimits(alertEnv(), NOW);
    expect(res.sent.map((a) => a.rule)).toEqual(['threshold']);
  });

  it('fires the weekly pace alert', async () => {
    await env.DB.batch([snap('seven_day', NOW - 60, 70, NOW + 3 * DAY)]); // pace 70/(4/7)/100 = 1.225
    const res = await evaluateAfterLimits(alertEnv(), NOW);
    expect(res.sent.map((a) => a.rule).sort()).toEqual(['pace']);
  });
});

describe('scheduled handler', () => {
  it('runs alerts from the cron', async () => {
    await env.DB.batch([snap('five_hour', NOW - 60, 95, NOW + HOUR), syncRun(NOW)]);
    // env has no NTFY_TOPIC binding in tests, so the cron path must be a silent no-op.
    await worker.scheduled(createScheduledController({ scheduledTime: NOW * 1000, cron: '*/5 * * * *' }), env);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
