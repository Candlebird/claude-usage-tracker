import {
  API_ROUTES,
  nowSeconds,
  type AlertTestResponse,
  type HealthResponse,
  type HeatmapResponse,
  type LimitsResponse,
  type LiveResponse,
  type ModelsResponse,
  type ProjectsResponse,
  type SessionDetail,
  type SessionSort,
  type SessionsResponse,
  type Settings,
  type SettingsUpdate,
  type StatusResponse,
  type SummaryResponse,
  type TimeRange,
  type TimeseriesBucket,
  type TimeseriesGroup,
  type TimeseriesMetric,
  type TimeseriesResponse,
} from '@ccu/shared';
import type { Connection } from './connection';
import { DemoHttpError, handleDemoRequest } from './demo/handler';

/** Non-2xx response, network failure (status 0) or an unparseable body. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

type QueryValue = string | number | null | undefined;
export type Query = Record<string, QueryValue>;

export interface TimeseriesParams extends TimeRange {
  bucket?: TimeseriesBucket;
  group?: TimeseriesGroup;
  metric?: TimeseriesMetric;
  tz?: string;
  /** Restricts to one project key (dashboard extension; ignored by servers that lack it). */
  project?: string;
}

export interface SessionsParams extends TimeRange {
  project?: string;
  limit?: number;
  offset?: number;
  sort?: SessionSort;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Low-level transport: real HTTP or the in-browser demo backend. */
export type Transport = (method: string, path: string, query: URLSearchParams, body: unknown, opts: RequestOptions) => Promise<unknown>;

export function toSearchParams(query: Query = {}): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') q.set(k, String(v));
  return q;
}

export function httpTransport(conn: Connection, fetchImpl: typeof fetch = (...a) => fetch(...a)): Transport {
  return async (method, path, query, body, opts) => {
    const qs = query.toString();
    const url = `${conn.apiUrl}${path}${qs ? '?' + qs : ''}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${conn.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: opts.signal,
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new ApiError(0, 'Could not reach the API. Check the URL and your connection.');
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError(res.status, 'The API returned something that is not JSON.');
      }
    }
    if (!res.ok) {
      const msg = (data as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof msg === 'string' ? msg : `Request failed (${res.status})`);
    }
    return data;
  };
}

/** Demo backend with a little latency so loading states are visible. */
export function demoTransport(tz: string, now: () => number = nowSeconds, latencyMs = 120): Transport {
  return async (method, path, query, body, opts) => {
    if (latencyMs > 0) await delay(latencyMs, opts.signal);
    try {
      return handleDemoRequest({ method, path, query, body }, now(), tz);
    } catch (e) {
      if (e instanceof DemoHttpError) throw new ApiError(e.status, e.message);
      throw e;
    }
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export interface ApiClient {
  readonly demo: boolean;
  summary(tz: string, o?: RequestOptions): Promise<SummaryResponse>;
  timeseries(p: TimeseriesParams, o?: RequestOptions): Promise<TimeseriesResponse>;
  limits(r: TimeRange, o?: RequestOptions): Promise<LimitsResponse>;
  projects(r: TimeRange & { tz?: string }, o?: RequestOptions): Promise<ProjectsResponse>;
  sessions(p: SessionsParams, o?: RequestOptions): Promise<SessionsResponse>;
  session(id: string, o?: RequestOptions): Promise<SessionDetail>;
  models(r: TimeRange, o?: RequestOptions): Promise<ModelsResponse>;
  heatmap(p: { weeks?: number; tz: string }, o?: RequestOptions): Promise<HeatmapResponse>;
  live(minutes?: number, o?: RequestOptions): Promise<LiveResponse>;
  status(o?: RequestOptions): Promise<StatusResponse>;
  health(o?: RequestOptions): Promise<HealthResponse>;
  getSettings(o?: RequestOptions): Promise<Settings>;
  putSettings(update: SettingsUpdate, o?: RequestOptions): Promise<Settings>;
  alertsTest(o?: RequestOptions): Promise<AlertTestResponse>;
}

export function createApiClient(transport: Transport, demo = false): ApiClient {
  const get = <T>(path: string, query: Query = {}, o: RequestOptions = {}) => transport('GET', path, toSearchParams(query), undefined, o) as Promise<T>;
  const send = <T>(method: string, path: string, body: unknown, o: RequestOptions = {}) => transport(method, path, new URLSearchParams(), body, o) as Promise<T>;
  return {
    demo,
    summary: (tz, o) => get(API_ROUTES.summary, { tz }, o),
    timeseries: (p, o) => get(API_ROUTES.timeseries, { ...p }, o),
    limits: (r, o) => get(API_ROUTES.limits, { ...r }, o),
    projects: (r, o) => get(API_ROUTES.projects, { ...r }, o),
    sessions: (p, o) => get(API_ROUTES.sessions, { ...p }, o),
    session: (id, o) => get(`${API_ROUTES.sessions}/${encodeURIComponent(id)}`, {}, o),
    models: (r, o) => get(API_ROUTES.models, { ...r }, o),
    heatmap: (p, o) => get(API_ROUTES.heatmap, { ...p }, o),
    live: (minutes = 60, o) => get(API_ROUTES.live, { minutes }, o),
    status: (o) => get(API_ROUTES.status, {}, o),
    health: (o) => get(API_ROUTES.health, {}, o),
    getSettings: (o) => get(API_ROUTES.settings, {}, o),
    putSettings: (u, o) => send('PUT', API_ROUTES.settings, u, o),
    alertsTest: (o) => send('POST', API_ROUTES.alertsTest, {}, o),
  };
}

/** Checks a URL + token pair the way the connect screen does: GET /api/summary must succeed. */
export async function validateConnection(conn: Connection, tz: string, fetchImpl?: typeof fetch): Promise<SummaryResponse> {
  return createApiClient(httpTransport(conn, fetchImpl)).summary(tz);
}
