import { accessOf, denyStatus, type AuthLevel } from './auth.js';
import { isAllowedOrigin, preflight, withCors } from './cors.js';
import type { Env } from './db.js';
import { errorResponse, HttpError, type RouteHandler } from './http.js';

export type Method = 'GET' | 'POST' | 'PUT';

export interface Route {
  method: Method;
  /** Literal path, or segments with `:name` parameters. */
  path: string;
  auth: AuthLevel;
  handler: RouteHandler;
}

function match(pattern: string, path: string): Record<string, string> | null {
  if (!pattern.includes(':')) return pattern === path ? {} : null;
  const ps = pattern.split('/');
  const xs = path.split('/');
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    const x = xs[i]!;
    if (p.startsWith(':')) {
      if (!x) return null;
      try {
        params[p.slice(1)] = decodeURIComponent(x);
      } catch {
        return null;
      }
    } else if (p !== x) return null;
  }
  return params;
}

export function createRouter(routes: readonly Route[]) {
  return async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const origin = req.headers.get('origin');
    const candidates = routes.flatMap((r) => {
      const params = match(r.path, path);
      return params ? [{ route: r, params }] : [];
    });

    if (candidates.length === 0) return withCors(errorResponse(404, 'not found'), origin, env);
    if (req.method === 'OPTIONS') return preflight(req, env);

    const hit = candidates.find((c) => c.route.method === req.method);
    if (!hit) {
      const allow = [...new Set(candidates.map((c) => c.route.method)), 'OPTIONS'].join(', ');
      return withCors(errorResponse(405, 'method not allowed', { Allow: allow }), origin, env);
    }

    const { route, params } = hit;
    try {
      if (route.auth !== 'public') {
        // Browsers always send Origin cross-site; CLI clients send none.
        if (origin !== null && !isAllowedOrigin(origin, env)) return withCors(errorResponse(403, 'origin not allowed'), origin, env);
        const deny = denyStatus(route.auth, await accessOf(req, env));
        if (deny === 401) return withCors(errorResponse(401, 'missing or invalid token', { 'WWW-Authenticate': 'Bearer' }), origin, env);
        if (deny === 403) return withCors(errorResponse(403, 'this route needs the write token'), origin, env);
      }
      const now = Math.floor(Date.now() / 1000);
      const res = await route.handler({ req, env, ctx, url, params, now });
      return withCors(res, origin, env);
    } catch (e) {
      if (e instanceof HttpError) return withCors(errorResponse(e.status, e.message), origin, env);
      console.error('unhandled error', req.method, path, e instanceof Error ? e.message : String(e));
      return withCors(errorResponse(500, 'internal error'), origin, env);
    }
  };
}
