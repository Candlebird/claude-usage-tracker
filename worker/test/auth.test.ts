import { describe, expect, it } from 'vitest';
import { call, ORIGIN, post, READ, WRITE } from './helpers.js';
import { usageIngest } from './fixtures.js';

const READ_GETS = [
  '/api/summary', '/api/timeseries', '/api/limits', '/api/projects', '/api/sessions', '/api/sessions/sess-1',
  '/api/models', '/api/heatmap', '/api/live', '/api/status', '/api/settings',
];

describe('auth matrix', () => {
  it('serves health without a token', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '2.0.0' });
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it.each([
    ['no token', null, 401],
    ['a wrong token', 'not-a-token', 401],
    ['the read token', READ, 403],
    ['the write token', WRITE, 200],
  ])('ingest with %s -> %i', async (_name, token, status) => {
    const res = await post('/api/ingest/usage', usageIngest(), token);
    expect(res.status).toBe(status);
    const body = (await res.json()) as Record<string, unknown>;
    if (status === 401) {
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(typeof body.error).toBe('string');
    }
  });

  it('rejects a token sent without the Bearer scheme', async () => {
    const res = await call('/api/ingest/usage', { method: 'POST', body: '{}', headers: { Authorization: WRITE } });
    expect(res.status).toBe(401);
  });

  it.each(['/v1/logs', '/v1/metrics', '/api/ingest/limits', '/api/ingest/daily-legacy'])('%s needs the write token', async (path) => {
    expect((await post(path, {}, null)).status).toBe(401);
    expect((await post(path, {}, READ)).status).toBe(403);
  });

  it.each(READ_GETS)('GET %s accepts read and write tokens only', async (path) => {
    expect((await call(path)).status).toBe(401);
    // Read handlers live in another module; anything but an auth failure proves the gate passed.
    for (const token of [READ, WRITE]) {
      const status = (await call(path, { token })).status;
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    }
  });

  it('lets the dashboard read token change settings and test alerts', async () => {
    expect((await call('/api/settings', { method: 'PUT', body: '{}' })).status).toBe(401);
    expect((await call('/api/settings', { method: 'PUT', body: '{}', token: READ })).status).not.toBe(401);
    expect((await post('/api/alerts/test', {}, null)).status).toBe(401);
    expect((await post('/api/alerts/test', {}, READ)).status).not.toBe(401);
  });
});

describe('routing', () => {
  it('answers 404 as JSON for unknown paths', async () => {
    const res = await call('/api/nope', { token: READ });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('answers 405 with Allow for the wrong method', async () => {
    const res = await call('/api/ingest/usage', { token: WRITE });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('ignores a trailing slash', async () => {
    expect((await call('/api/health/')).status).toBe(200);
  });
});

describe('CORS', () => {
  it('answers preflight for an allowed origin', async () => {
    const res = await call('/api/summary', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });

  it('refuses preflight for other origins', async () => {
    const res = await call('/api/summary', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes an allowed origin and varies on Origin', async () => {
    const res = await call('/api/health', { headers: { Origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('blocks authenticated routes from a foreign browser origin even with a valid token', async () => {
    const res = await call('/api/summary', { token: READ, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps CORS headers on auth errors so the browser can read them', async () => {
    const res = await call('/api/summary', { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});
