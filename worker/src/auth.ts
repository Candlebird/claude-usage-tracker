// Constant-time bearer token checks. Both sides are hashed first so the compare
// runs on equal-length buffers and leaks neither content nor length.
import type { Env } from './db.js';

export type Access = 'none' | 'read' | 'write';

/** What a route needs: `write` = WRITE_TOKEN only, `read` = READ or WRITE, `public` = nothing. */
export type AuthLevel = 'public' | 'read' | 'write';

const encoder = new TextEncoder();

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(s));
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

/** Which token (if any) the request carries. Empty configured tokens never match. */
export async function accessOf(req: Request, env: Pick<Env, 'READ_TOKEN' | 'WRITE_TOKEN'>): Promise<Access> {
  const token = bearerToken(req);
  if (!token) return 'none';
  const [isWrite, isRead] = await Promise.all([
    env.WRITE_TOKEN ? safeEqual(token, env.WRITE_TOKEN) : Promise.resolve(false),
    env.READ_TOKEN ? safeEqual(token, env.READ_TOKEN) : Promise.resolve(false),
  ]);
  if (isWrite) return 'write';
  if (isRead) return 'read';
  return 'none';
}

/** null when allowed, otherwise the status to return (401 no/bad token, 403 read token on a write route). */
export function denyStatus(level: AuthLevel, access: Access): 401 | 403 | null {
  if (level === 'public') return null;
  if (access === 'none') return 401;
  if (level === 'write' && access !== 'write') return 403;
  return null;
}
