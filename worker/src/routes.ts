import { API_ROUTES, type HealthResponse } from '@ccu/shared';
import { json } from './http.js';
import type { Route } from './router.js';
import { ingestDailyLegacy, ingestLimits, ingestUsage } from './routes/ingest.js';
import { otlpLogs, otlpMetrics } from './routes/otlp.js';
import * as read from './routes/read.js';
import { API_VERSION } from './version.js';

const health: Route['handler'] = () => json({ ok: true, version: API_VERSION } satisfies HealthResponse);

export const ROUTES: readonly Route[] = [
  { method: 'GET', path: API_ROUTES.health, auth: 'public', handler: health },

  { method: 'POST', path: API_ROUTES.ingestUsage, auth: 'write', handler: ingestUsage },
  { method: 'POST', path: API_ROUTES.ingestLimits, auth: 'write', handler: ingestLimits },
  { method: 'POST', path: API_ROUTES.ingestDailyLegacy, auth: 'write', handler: ingestDailyLegacy },
  { method: 'POST', path: API_ROUTES.otlpLogs, auth: 'write', handler: otlpLogs },
  { method: 'POST', path: API_ROUTES.otlpMetrics, auth: 'write', handler: otlpMetrics },

  { method: 'GET', path: API_ROUTES.summary, auth: 'read', handler: read.summary },
  { method: 'GET', path: API_ROUTES.timeseries, auth: 'read', handler: read.timeseries },
  { method: 'GET', path: API_ROUTES.limits, auth: 'read', handler: read.limits },
  { method: 'GET', path: API_ROUTES.projects, auth: 'read', handler: read.projects },
  { method: 'GET', path: API_ROUTES.sessions, auth: 'read', handler: read.sessions },
  { method: 'GET', path: `${API_ROUTES.sessions}/:id`, auth: 'read', handler: read.sessionDetail },
  { method: 'GET', path: API_ROUTES.models, auth: 'read', handler: read.models },
  { method: 'GET', path: API_ROUTES.heatmap, auth: 'read', handler: read.heatmap },
  { method: 'GET', path: API_ROUTES.live, auth: 'read', handler: read.live },
  { method: 'GET', path: API_ROUTES.status, auth: 'read', handler: read.status },
  { method: 'GET', path: API_ROUTES.settings, auth: 'read', handler: read.getSettings },
  // The dashboard only holds the read token, so these accept READ as well.
  { method: 'PUT', path: API_ROUTES.settings, auth: 'read', handler: read.putSettings },
  { method: 'POST', path: API_ROUTES.alertsTest, auth: 'read', handler: read.alertsTest },
];
