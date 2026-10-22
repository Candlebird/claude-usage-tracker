import { defaultRange, isValidTimeZone, TS_MAX, TS_MIN } from '@ccu/shared';
import type { Env } from './db.js';

export interface RouteContext {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  /** Path parameters, e.g. `{ id }` for `/api/sessions/:id`. */
  params: Record<string, string>;
  /** Request time, unix seconds. */
  now: number;
}

export type RouteHandler = (c: RouteContext) => Promise<Response> | Response;

/** Throw to return `{error}` with a status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorResponse(status: number, message: string, headers: HeadersInit = {}): Response {
  return json({ error: message }, status, headers);
}

// ---------------------------------------------------------------------------
// Body reading with a byte cap (checked on the wire and after gunzip)
// ---------------------------------------------------------------------------

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, `body exceeds ${maxBytes} bytes; send smaller chunks`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Reads the body as text, enforcing `maxBytes` (decoded size too when gzip-encoded). */
export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, `body exceeds ${maxBytes} bytes; send smaller chunks`);
  if (!req.body) return '';
  const encoding = (req.headers.get('content-encoding') ?? '').trim().toLowerCase();
  let stream: ReadableStream<Uint8Array> = req.body;
  if (encoding === 'gzip') {
    stream = req.body.pipeThrough(new DecompressionStream('gzip'));
  } else if (encoding !== '' && encoding !== 'identity') {
    throw new HttpError(415, `unsupported content-encoding: ${encoding.slice(0, 32)}`);
  }
  try {
    return new TextDecoder().decode(await readCapped(stream, maxBytes));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'could not read request body');
  }
}

export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const text = await readBodyText(req, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/** Integer query param clamped to [min, max]; `def` when absent or invalid. */
export function intParam(url: URL, name: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** `from`/`to` in unix seconds; defaults to the last `days` days. Throws 400 when from > to. */
export function rangeParams(url: URL, now: number, days = 7): { from: number; to: number } {
  const def = defaultRange(now, days);
  const from = intParam(url, 'from', def.from, TS_MIN, TS_MAX);
  const to = intParam(url, 'to', def.to, TS_MIN, TS_MAX);
  if (from > to) throw new HttpError(400, 'from must be <= to');
  return { from, to };
}

/** `tz` query param when it is a valid IANA zone, else the configured default. */
export function tzParam(url: URL, env: Pick<Env, 'TZ_NAME'>): string {
  const tz = url.searchParams.get('tz');
  if (tz && tz.length <= 64 && isValidTimeZone(tz)) return tz;
  return isValidTimeZone(env.TZ_NAME) ? env.TZ_NAME : 'UTC';
}
