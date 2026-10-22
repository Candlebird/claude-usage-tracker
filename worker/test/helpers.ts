import { exports } from 'cloudflare:workers';

export const READ = 'test-read-token';
export const WRITE = 'test-write-token';
export const ORIGIN = 'http://localhost:5173';

export function call(path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
  return exports.default.fetch(new Request(`https://api.test${path}`, { ...rest, headers }));
}

export function post(path: string, body: unknown, token: string | null = WRITE): Promise<Response> {
  return call(path, { method: 'POST', body: JSON.stringify(body), token });
}
