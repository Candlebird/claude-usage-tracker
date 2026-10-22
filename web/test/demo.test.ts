import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_ROUTES,
  type HeatmapResponse,
  type LimitsResponse,
  type LiveResponse,
  type ModelsResponse,
  type ProjectsResponse,
  type SessionDetail,
  type SessionsResponse,
  type Settings,
  type StatusResponse,
  type SummaryResponse,
  type TimeseriesResponse,
} from '@ccu/shared';
import { DemoHttpError, handleDemoRequest, resetDemoState } from '../src/demo/handler';

// A fixed instant: the demo data is a pure function of (now, tz).
const NOW = 1_792_670_400; // 2026-10-22T12:00:00Z
const TZ = 'UTC';
const DAY = 86400;

function get<T>(path: string, query: Record<string, string | number> = {}): T {
  const q = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  return handleDemoRequest({ path, query: q }, NOW, TZ) as T;
}

const range30 = { from: NOW - 30 * DAY, to: NOW };

beforeEach(() => resetDemoState());

describe('demo backend', () => {
  it('is deterministic for the same instant', () => {
    const a = JSON.stringify(get(API_ROUTES.summary, { tz: TZ }));
    resetDemoState();
    const b = JSON.stringify(get(API_ROUTES.summary, { tz: TZ }));
    expect(a).toBe(b);
  });

  it('serves a well-formed summary', () => {
    const s = get<SummaryResponse>(API_ROUTES.summary, { tz: TZ });
    expect(s.tz).toBe(TZ);
    for (const p of [s.today, s.last7d, s.last30d]) {
      expect(p.costUsd).toBeGreaterThanOrEqual(0);
      expect(p.cacheHitRate).toBeGreaterThanOrEqual(0);
      expect(p.cacheHitRate).toBeLessThanOrEqual(1);
    }
    expect(s.last30d.costUsd).toBeGreaterThan(s.last7d.costUsd);
    expect(s.limits.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps limit windows in a realistic band', () => {
    const l = get<LimitsResponse>(API_ROUTES.limits, range30);
    expect(l.current.length).toBeGreaterThanOrEqual(2);
    for (const w of l.current) {
      expect(w.utilization).toBeGreaterThanOrEqual(0);
      expect(w.utilization).toBeLessThanOrEqual(100);
      expect(w.resetsAt).toBeGreaterThan(NOW);
    }
    const peaks = l.blocks.map((b) => b.peakUtilization);
    expect(peaks.length).toBeGreaterThan(5);
    expect(Math.max(...peaks)).toBeGreaterThanOrEqual(25);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(100);
    const weekly = l.current.find((w) => w.key === 'seven_day');
    expect(weekly).toBeDefined();
    expect(weekly!.utilization).toBeGreaterThan(5);
    expect(weekly!.utilization).toBeLessThan(100);
    for (const b of l.blocks) expect(b.end - b.start).toBe(5 * 3600);
  });

  it('serves timeseries for every group', () => {
    for (const group of ['model', 'project', 'agent_kind', 'type'] as const) {
      const t = get<TimeseriesResponse>(API_ROUTES.timeseries, { ...range30, bucket: 'day', group, metric: 'cost', tz: TZ });
      expect(t.series.length).toBeGreaterThan(0);
      for (const s of t.series) {
        for (const [ts, v] of s.points) {
          expect(ts).toBeGreaterThanOrEqual(range30.from - DAY);
          expect(ts).toBeLessThanOrEqual(NOW);
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('serves projects, sessions and a session detail', () => {
    const p = get<ProjectsResponse>(API_ROUTES.projects, range30);
    expect(p.projects.length).toBeGreaterThan(1);
    const s = get<SessionsResponse>(API_ROUTES.sessions, { ...range30, sort: 'cost', limit: 10 });
    expect(s.sessions.length).toBeGreaterThan(0);
    expect(s.sessions.length).toBeLessThanOrEqual(10);
    const costs = s.sessions.map((x) => x.costUsd);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
    const filtered = get<SessionsResponse>(API_ROUTES.sessions, { ...range30, project: p.projects[0]!.project });
    for (const row of filtered.sessions) expect(row.project).toBe(p.projects[0]!.project);
    const d = get<SessionDetail>(`${API_ROUTES.sessions}/${encodeURIComponent(s.sessions[0]!.sessionId)}`);
    expect(d.session.sessionId).toBe(s.sessions[0]!.sessionId);
  });

  it('serves models, heatmap, live and status', () => {
    const m = get<ModelsResponse>(API_ROUTES.models, range30);
    expect(m.models.length).toBeGreaterThan(1);
    const h = get<HeatmapResponse>(API_ROUTES.heatmap, { weeks: 8, tz: TZ });
    for (const c of h.grid) {
      expect(c.dow).toBeGreaterThanOrEqual(0);
      expect(c.dow).toBeLessThan(7);
      expect(c.hour).toBeGreaterThanOrEqual(0);
      expect(c.hour).toBeLessThan(24);
    }
    expect(h.calendar.length).toBeGreaterThan(50);
    const live = get<LiveResponse>(API_ROUTES.live, { minutes: 60 });
    expect(live.recent.length).toBeLessThanOrEqual(50);
    const st = get<StatusResponse>(API_ROUTES.status);
    expect(st).toBeTruthy();
  });

  it('round-trips settings and rejects unknown routes', () => {
    const put = handleDemoRequest({ method: 'PUT', path: API_ROUTES.settings, body: { dailyBudgetUsd: 42 } }, NOW, TZ) as Settings;
    expect(put.dailyBudgetUsd).toBe(42);
    expect(get<Settings>(API_ROUTES.settings).dailyBudgetUsd).toBe(42);
    expect(() => get('/api/nope')).toThrow(DemoHttpError);
  });
});
