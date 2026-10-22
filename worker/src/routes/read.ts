// READ-token routes. Handlers parse params and delegate to the read-* builders.
import {
  FIVE_HOUR_SECONDS,
  validateSettingsUpdate,
  type AlertTestResponse,
  type LimitsResponse,
  type SessionSort,
  type TimeseriesBucket,
  type TimeseriesGroup,
  type TimeseriesMetric,
} from '@ccu/shared';
import { ntfyUrl, sendNtfy } from '../alerts.js';
import { getMeta, getSettings as loadSettings, putSettings as saveSettings, setMeta } from '../db.js';
import { HttpError, intParam, json, rangeParams, readJson, tzParam, type RouteHandler } from '../http.js';
import { HOUR_MID } from './read-days.js';
import {
  blockDrafts,
  buildBlocks,
  currentLimits,
  hitsOf,
  historySeries,
  HITS_RANGE_SQL,
  LATEST_SNAPSHOTS_SQL,
  SNAPSHOT_RANGE_SQL,
  type HourUsage,
  type SnapshotRow,
} from './read-limits.js';
import { buildLive, buildStatus } from './read-ops.js';
import { buildSessionDetail, buildSessions } from './read-sessions.js';
import { buildSummary } from './read-summary.js';
import { buildHeatmap, buildModels, buildProjects, buildTimeseries } from './read-usage.js';

const SETTINGS_MAX_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 200;

function enumParam<T extends string>(url: URL, name: string, allowed: readonly T[], def: T): T {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return def;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new HttpError(400, `${name} must be one of ${allowed.join(', ')}`);
}

function stringParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  if (raw.length > MAX_ID_LENGTH) throw new HttpError(400, `${name} is too long`);
  return raw;
}

export const summary: RouteHandler = async ({ env, url, now }) => json(await buildSummary(env, tzParam(url, env), now));

export const timeseries: RouteHandler = async ({ env, url, now }) => {
  const { from, to } = rangeParams(url, now);
  return json(
    await buildTimeseries(env, {
      from,
      to,
      bucket: enumParam<TimeseriesBucket>(url, 'bucket', ['hour', 'day'], 'day'),
      group: enumParam<TimeseriesGroup>(url, 'group', ['model', 'project', 'agent_kind', 'type'], 'model'),
      metric: enumParam<TimeseriesMetric>(url, 'metric', ['cost', 'tokens', 'requests'], 'cost'),
      tz: tzParam(url, env),
      project: stringParam(url, 'project'),
    }),
  );
};

const LIMITS_HOURS_SQL = `SELECT hour, TOTAL(cost_usd) AS costUsd,
  TOTAL(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens, TOTAL(requests) AS requests
FROM usage_hourly WHERE hour >= ?1 AND hour <= ?2 GROUP BY hour`;

export const limits: RouteHandler = async ({ env, url, now }) => {
  const { from, to } = rangeParams(url, now);
  const db = env.DB;
  // Blocks overlapping the range can start up to 5h before it and end 5h after it.
  const snapFrom = from - FIVE_HOUR_SECONDS;
  const snapTo = to + FIVE_HOUR_SECONDS;
  const [snapRes, hitsRes, latestRes, hoursRes] = await db.batch([
    db.prepare(SNAPSHOT_RANGE_SQL).bind(snapFrom, snapTo),
    db.prepare(HITS_RANGE_SQL).bind(from, to),
    db.prepare(LATEST_SNAPSHOTS_SQL),
    db.prepare(LIMITS_HOURS_SQL).bind(snapFrom - HOUR_MID, snapTo),
  ]);
  const snaps = (snapRes!.results ?? []) as SnapshotRow[];
  const body: LimitsResponse = {
    from,
    to,
    windows: historySeries(snaps, from, to),
    hits: hitsOf((hitsRes!.results ?? []) as { ts: number; kind: string; resetsAt: number | null }[]),
    blocks: buildBlocks(
      blockDrafts(snaps.filter((s) => s.key === 'five_hour')),
      (hoursRes!.results ?? []) as HourUsage[],
      from,
      to,
      now,
    ),
    current: currentLimits((latestRes!.results ?? []) as SnapshotRow[], now),
  };
  return json(body);
};

export const projects: RouteHandler = async ({ env, url, now }) => {
  const { from, to } = rangeParams(url, now);
  return json(await buildProjects(env, from, to, tzParam(url, env)));
};

export const sessions: RouteHandler = async ({ env, url, now }) => {
  const { from, to } = rangeParams(url, now);
  return json(
    await buildSessions(env, {
      from,
      to,
      project: stringParam(url, 'project'),
      sort: enumParam<SessionSort>(url, 'sort', ['cost', 'recent'], 'recent'),
      limit: intParam(url, 'limit', 50, 1, 100),
      offset: intParam(url, 'offset', 0, 0, 1_000_000),
    }),
  );
};

export const sessionDetail: RouteHandler = async ({ env, params }) => {
  const id = params.id ?? '';
  if (!id || id.length > MAX_ID_LENGTH) throw new HttpError(400, 'invalid session id');
  return json(await buildSessionDetail(env, id));
};

export const models: RouteHandler = async ({ env, url, now }) => {
  const { from, to } = rangeParams(url, now);
  return json(await buildModels(env, from, to));
};

export const heatmap: RouteHandler = async ({ env, url, now }) =>
  json(await buildHeatmap(env, intParam(url, 'weeks', 12, 1, 52), tzParam(url, env), now));

export const live: RouteHandler = async ({ env, url, now }) => json(await buildLive(env, intParam(url, 'minutes', 60, 1, 1440), now));

export const status: RouteHandler = async ({ env, now }) => json(await buildStatus(env, now));

export const getSettings: RouteHandler = async ({ env }) => json(await loadSettings(env));

export const putSettings: RouteHandler = async ({ env, req }) => {
  const parsed = validateSettingsUpdate(await readJson(req, SETTINGS_MAX_BYTES));
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  return json(await saveSettings(env, parsed.value));
};

/** Minimum gap between test pushes; the READ token lives in the browser, so it must not become an ntfy spam relay. */
export const ALERT_TEST_COOLDOWN = 60;
const META_ALERT_TEST = 'alertTest';

export const alertsTest: RouteHandler = async ({ env, now }) => {
  // Only a configured topic makes an outbound request, so only that is rate limited.
  if (ntfyUrl(env) !== null) {
    const last = await getMeta<number>(env.DB, META_ALERT_TEST);
    const wait = last === null ? 0 : last + ALERT_TEST_COOLDOWN - now;
    if (wait > 0) throw new HttpError(429, `test alert rate limited; retry in ${wait}s`);
    await setMeta(env.DB, META_ALERT_TEST, now);
  }
  const r = await sendNtfy(env, {
    title: 'Test alert',
    message: 'Claude Usage Tracker test notification',
    priority: 'default',
    tags: ['test_tube'],
  });
  const body: AlertTestResponse = { ok: true, sent: r.sent };
  if (r.error) body.error = r.error;
  return json(body);
};
