import type { Env } from './db.js';

export const CORS_METHODS = 'GET, POST, PUT, OPTIONS';
export const CORS_HEADERS = 'Authorization, Content-Type';

export function allowedOrigins(env: Pick<Env, 'ALLOWED_ORIGINS'>): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | null, env: Pick<Env, 'ALLOWED_ORIGINS'>): boolean {
  return origin !== null && allowedOrigins(env).includes(origin);
}

/** Adds CORS headers when the origin is allowed; always varies on Origin. */
export function withCors(res: Response, origin: string | null, env: Pick<Env, 'ALLOWED_ORIGINS'>): Response {
  const out = new Response(res.body, res);
  out.headers.append('Vary', 'Origin');
  if (origin && isAllowedOrigin(origin, env)) {
    out.headers.set('Access-Control-Allow-Origin', origin);
  }
  return out;
}

export function preflight(req: Request, env: Pick<Env, 'ALLOWED_ORIGINS'>): Response {
  const origin = req.headers.get('origin');
  if (!isAllowedOrigin(origin, env)) {
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin!,
      'Access-Control-Allow-Methods': CORS_METHODS,
      'Access-Control-Allow-Headers': CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}
