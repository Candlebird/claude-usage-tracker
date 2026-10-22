// Synthetic seed helpers for read-route tests. All ids and values are made up.
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { RouteHandler } from '../src/http.js';

export const READ_TABLES = [
  'usage_hourly',
  'sessions',
  'projects',
  'limit_snapshots',
  'limit_hits',
  'live_requests',
  'daily_legacy',
  'sync_runs',
  'alert_state',
  'settings',
];

export async function clearTables(): Promise<void> {
  await env.DB.batch(READ_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export interface UsageSeed {
  hour: number;
  project?: string;
  model?: string;
  agentKind?: string;
  sessionId?: string;
  requests?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearch?: number;
  costUsd?: number;
}

export async function seedUsage(rows: UsageSeed[]): Promise<void> {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO usage_hourly (hour, project, model, agent_kind, session_id, requests, input, output, cache_read,
          cache_write_5m, cache_write_1h, web_search, cost_usd) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(
        r.hour,
        r.project ?? 'proj-a',
        r.model ?? 'claude-sonnet-4-5',
        r.agentKind ?? 'main',
        r.sessionId ?? 'sess-1',
        r.requests ?? 1,
        r.input ?? 0,
        r.output ?? 0,
        r.cacheRead ?? 0,
        r.cacheWrite5m ?? 0,
        r.cacheWrite1h ?? 0,
        r.webSearch ?? 0,
        r.costUsd ?? 0,
      ),
    ),
  );
}

export interface SessionSeed {
  sessionId: string;
  project?: string;
  title?: string | null;
  firstTs: number;
  lastTs: number;
  models?: string[];
  agentCount?: number;
  costStateUsd?: number | null;
}

export async function seedSessions(rows: SessionSeed[]): Promise<void> {
  await env.DB.batch(
    rows.map((s) =>
      env.DB.prepare(
        `INSERT INTO sessions (session_id, project, title, git_branch, first_ts, last_ts, models, agent_count, cost_state_usd)
         VALUES (?1, ?2, ?3, 'main', ?4, ?5, ?6, ?7, ?8)`,
      ).bind(s.sessionId, s.project ?? 'proj-a', s.title ?? null, s.firstTs, s.lastTs, JSON.stringify(s.models ?? []), s.agentCount ?? 0, s.costStateUsd ?? null),
    ),
  );
}

export async function exec(sql: string, ...binds: (string | number | null)[]): Promise<void> {
  await env.DB.prepare(sql)
    .bind(...binds)
    .run();
}

/** Calls a handler directly so the test controls `now`. */
export async function invoke(
  handler: RouteHandler,
  path: string,
  opts: { now: number; params?: Record<string, string>; init?: RequestInit; env?: Partial<typeof env> } = { now: 0 },
): Promise<Response> {
  const url = new URL(`https://api.test${path}`);
  const req = new Request(url, opts.init);
  return handler({
    req,
    env: { ...env, ...(opts.env ?? {}) },
    ctx: createExecutionContext(),
    url,
    params: opts.params ?? {},
    now: opts.now,
  });
}

export async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
