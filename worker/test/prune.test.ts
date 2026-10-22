import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import {
  ALERT_RESET_GRACE,
  ALERT_STATE_RETENTION,
  LIVE_RETENTION,
  prune,
  PRUNE_SQL,
  shouldPrune,
  SNAPSHOT_FULL_RES,
  SNAPSHOT_RETENTION,
  SYNC_RUNS_RETENTION,
} from '../src/prune.js';

const NOW = 1_800_003_600 - (1_800_003_600 % 3600) + 120; // two minutes past a UTC hour

async function seed(): Promise<void> {
  const live = (id: string, ts: number) => env.DB.prepare('INSERT INTO live_requests (request_id, ts) VALUES (?, ?)').bind(id, ts);
  const snap = (key: string, ts: number) =>
    env.DB.prepare('INSERT INTO limit_snapshots (ts, window_key, utilization, resets_at) VALUES (?, ?, 1, ?)').bind(ts, key, ts + 3600);
  const thinHour = NOW - SNAPSHOT_FULL_RES - 3 * 3600; // an hour start well inside the thinning range
  await env.DB.batch([
    live('old', NOW - LIVE_RETENTION - 1),
    live('fresh', NOW - 60),
    snap('five_hour', NOW - SNAPSHOT_RETENTION - 10),
    snap('five_hour', thinHour),
    snap('five_hour', thinHour + 300),
    snap('five_hour', thinHour + 600),
    snap('seven_day', thinHour + 300),
    snap('five_hour', thinHour + 3600),
    snap('five_hour', NOW - 600),
    snap('five_hour', NOW - 300),
    env.DB.prepare('INSERT INTO sync_runs (ts, device, rows) VALUES (?, ?, 1)').bind(NOW - SYNC_RUNS_RETENTION - 1, 'pc'),
    env.DB.prepare('INSERT INTO sync_runs (ts, device, rows) VALUES (?, ?, 1)').bind(NOW - 300, 'pc'),
    env.DB.prepare('INSERT INTO sync_runs (ts, device, rows) VALUES (?, ?, 1)').bind(NOW - 60 * 86400, 'pc'), // kept: < 90 days
  ]);
}

const alertRow = (key: string, firedAt: number, reset: number | null) =>
  env.DB.prepare('INSERT INTO alert_state (alert_key, fired_at, window_reset) VALUES (?, ?, ?)').bind(key, firedAt, reset);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM live_requests'),
    env.DB.prepare('DELETE FROM limit_snapshots'),
    env.DB.prepare('DELETE FROM sync_runs'),
    env.DB.prepare('DELETE FROM alert_state'),
  ]);
});

describe('prune', () => {
  it('drops expired rows and thins old snapshots to one per window per hour', async () => {
    await seed();
    expect(await prune(env, NOW)).toEqual({ liveRequests: 1, snapshotsExpired: 1, snapshotsThinned: 2, syncRuns: 1, alertState: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_runs').first('n')).toBe(2);
    const live = await env.DB.prepare('SELECT request_id FROM live_requests').all();
    expect(live.results).toEqual([{ request_id: 'fresh' }]);
    const snaps = await env.DB.prepare('SELECT COUNT(*) AS n FROM limit_snapshots').first<{ n: number }>();
    expect(snaps?.n).toBe(5);
    // Running again changes nothing.
    expect(await prune(env, NOW)).toEqual({ liveRequests: 0, snapshotsExpired: 0, snapshotsThinned: 0, syncRuns: 0, alertState: 0 });
  });

  it('drops stale alert_state rows: old, or for a window that reset long ago', async () => {
    await env.DB.batch([
      alertRow('old', NOW - ALERT_STATE_RETENTION - 1, null),
      alertRow('threshold:five_hour:90:1', NOW - 3600, NOW - ALERT_RESET_GRACE - 1),
      alertRow('threshold:seven_day:75:2', NOW - 3600, NOW + 86400),
      alertRow('hit:five_hour:3', NOW - 600, NOW - 3600), // reset just passed: kept
      alertRow('stale:4', NOW - 5 * 86400, NOW - 5 * 86400), // stale keys age out by fired_at only
      alertRow('hit:unknown:5', NOW - 600, null),
    ]);
    expect((await prune(env, NOW)).alertState).toBe(2);
    const keys = await env.DB.prepare('SELECT alert_key FROM alert_state ORDER BY alert_key').all<{ alert_key: string }>();
    expect(keys.results.map((r) => r.alert_key)).toEqual(['hit:five_hour:3', 'hit:unknown:5', 'stale:4', 'threshold:seven_day:75:2']);
  });

  it('seeks on primary keys instead of scanning tables', async () => {
    for (const [name, sql] of Object.entries(PRUNE_SQL)) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...(sql.includes('?2') ? [1, 2] : [1])).all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail);
      expect(details.length, name).toBeGreaterThan(0);
      expect(details.filter((d) => /^SCAN (limit_snapshots|live_requests|sync_runs)/.test(d)), name).toEqual([]);
    }
  });

  it('runs only in the first minutes of each hour', () => {
    expect(shouldPrune(NOW)).toBe(true);
    expect(shouldPrune(NOW + 3 * 60)).toBe(false);
    expect(shouldPrune(NOW - 120 + 4 * 60 + 59)).toBe(true);
  });
});

describe('scheduled', () => {
  it('prunes at the top of the hour', async () => {
    await seed();
    await worker.scheduled(createScheduledController({ scheduledTime: NOW * 1000, cron: '*/5 * * * *' }), env);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM live_requests').first('n')).toBe(1);
  });

  it('leaves data alone mid-hour', async () => {
    await seed();
    await worker.scheduled(createScheduledController({ scheduledTime: (NOW + 30 * 60) * 1000, cron: '*/5 * * * *' }), env);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM live_requests').first('n')).toBe(2);
  });
});
