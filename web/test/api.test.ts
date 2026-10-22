import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, demoTransport, httpTransport, isUnauthorized, validateConnection } from '../src/api';
import { normalizeApiUrl } from '../src/connection';

// Synthetic placeholders only; nothing here is a real endpoint or credential.
const CONN = { apiUrl: 'https://api.example.test', token: 'test-read-token' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(body === undefined ? '' : JSON.stringify(body), { status }));
}

describe('api client', () => {
  it('sends the bearer token and query string', async () => {
    const f = fakeFetch(200, { ok: true, version: 'x' });
    const api = createApiClient(httpTransport(CONN, f as unknown as typeof fetch));
    await api.timeseries({ from: 1, to: 2, group: 'model', project: undefined });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/api/timeseries?from=1&to=2&group=model');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-read-token');
  });

  it('turns a 401 into an unauthorized ApiError', async () => {
    const f = fakeFetch(401, { error: 'bad token' });
    const err = await validateConnection(CONN, 'UTC', f as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isUnauthorized(err)).toBe(true);
    expect((err as ApiError).message).toBe('bad token');
  });

  it('reports network failures as status 0', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const err = await createApiClient(httpTransport(CONN, f as unknown as typeof fetch))
      .health()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });

  it('serves the demo backend through the same client', async () => {
    const api = createApiClient(demoTransport('UTC', () => 1_792_670_400, 0), true);
    const s = await api.summary('UTC');
    expect(s.tz).toBe('UTC');
    const err = await api.session('no-such-session').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('normalizes API URLs', () => {
    expect(normalizeApiUrl(' api.example.test/ ')).toBe('https://api.example.test');
    expect(normalizeApiUrl('http://localhost:8787//')).toBe('http://localhost:8787');
    expect(normalizeApiUrl('')).toBe('');
  });
});
