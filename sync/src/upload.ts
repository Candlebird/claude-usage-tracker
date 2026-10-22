// HTTP upload to the Worker: chunked, retried with backoff, and safe to interrupt (state is
// persisted by the caller after each acknowledged chunk).
import {
  API_ROUTES,
  STRING_LIMITS,
  type HourlyBucket,
  type LimitHit,
  type ProjectMeta,
  type SessionMeta,
  type SyncRunStats,
  type UsageIngest,
  validateUsageIngest,
} from '@ccu/shared';

export const MAX_ROWS_PER_REQUEST = 500;
export const UPLOAD_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PostOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts in total, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

export type PostResult =
  | { ok: true; status: number; body: unknown }
  /** `fatal`: a 4xx other than 408/429; retrying the same payload cannot succeed. */
  | { ok: false; status: number | null; fatal: boolean; error: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function clampMsg(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > STRING_LIMITS.error ? `${one.slice(0, STRING_LIMITS.error - 3)}...` : one;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function retryable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

async function serverError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const o = JSON.parse(text);
      if (o && typeof o.error === 'string') return o.error;
    } catch {
      // not JSON
    }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

/** POST JSON with a Bearer token. Retries 5xx/429/408/network errors with exponential backoff. */
export async function postJson(url: string, token: string, payload: unknown, opts: PostOptions = {}): Promise<PostResult> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = opts.baseDelayMs ?? 1000;
  const body = JSON.stringify(payload);
  let last: PostResult = { ok: false, status: null, fatal: false, error: 'not attempted' };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(base * 2 ** (i - 1));
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? UPLOAD_TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      last = { ok: false, status: null, fatal: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'upload timed out' : 'upload failed: network error' };
      continue;
    }
    if (res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // an empty or non-JSON 2xx is still an ack
      }
      return { ok: true, status: res.status, body: parsed };
    }
    const msg = await serverError(res);
    const error = clampMsg(`upload rejected: HTTP ${res.status}${msg ? ` ${msg}` : ''}`);
    if (!retryable(res.status)) return { ok: false, status: res.status, fatal: true, error };
    last = { ok: false, status: res.status, fatal: false, error };
  }
  return last;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface PlanRows {
  buckets: HourlyBucket[];
  sessions: SessionMeta[];
  projects: ProjectMeta[];
  limitHits: LimitHit[];
}

export function planRowCount(p: PlanRows): number {
  return p.buckets.length + p.sessions.length + p.projects.length + p.limitHits.length;
}

/**
 * Splits a plan into chunks of at most `maxRows` rows, in dependency order: projects, limit hits,
 * sessions, then buckets (so a bucket never lands before the session/project rows it refers to).
 */
export function chunkPlan(p: PlanRows, maxRows = MAX_ROWS_PER_REQUEST): PlanRows[] {
  const size = Math.max(1, maxRows);
  const chunks: PlanRows[] = [];
  let cur: PlanRows = { buckets: [], sessions: [], projects: [], limitHits: [] };
  let n = 0;
  const push = <K extends keyof PlanRows>(key: K, items: PlanRows[K]) => {
    for (const item of items) {
      if (n === size) {
        chunks.push(cur);
        cur = { buckets: [], sessions: [], projects: [], limitHits: [] };
        n = 0;
      }
      (cur[key] as unknown[]).push(item);
      n++;
    }
  };
  push('projects', p.projects);
  push('limitHits', p.limitHits);
  push('sessions', p.sessions);
  push('buckets', p.buckets);
  if (n > 0) chunks.push(cur);
  return chunks;
}

export function toIngest(chunk: PlanRows, meta: { device: string; version: string; pending: number; stats?: SyncRunStats }): UsageIngest {
  const out: UsageIngest = { device: meta.device, version: meta.version, buckets: chunk.buckets, pending: meta.pending };
  if (chunk.sessions.length) out.sessions = chunk.sessions;
  if (chunk.projects.length) out.projects = chunk.projects;
  if (chunk.limitHits.length) out.limitHits = chunk.limitHits;
  if (meta.stats) out.stats = meta.stats;
  return out;
}

/**
 * Validates each row on its own against the shared ingest validator and drops the ones the Worker
 * would reject, so one malformed row cannot block every later upload. Dropped rows stay dirty
 * locally and are reported every run.
 */
export function dropInvalidRows(p: PlanRows, meta: { device: string; version: string }): { plan: PlanRows; rejected: string[] } {
  const rejected: string[] = [];
  const keep = <K extends keyof PlanRows>(key: K): PlanRows[K] =>
    (p[key] as unknown[]).filter((row) => {
      const v = validateUsageIngest({ device: meta.device, version: meta.version, buckets: [], [key]: [row] });
      if (!v.ok) rejected.push(v.error);
      return v.ok;
    }) as PlanRows[K];
  return { plan: { projects: keep('projects'), limitHits: keep('limitHits'), sessions: keep('sessions'), buckets: keep('buckets') }, rejected };
}

export interface UploadPlanOptions extends PostOptions {
  apiUrl: string;
  writeToken: string;
  device: string;
  version: string;
  /** Dirty rows left over after this plan (from planUpload). */
  pendingAfterPlan: number;
  stats?: SyncRunStats;
  maxRowsPerRequest?: number;
  /** Persist progress; called after every 2xx before the next chunk is sent. */
  onChunkAcked: (chunk: PlanRows) => void;
}

export interface UploadOutcome {
  chunksSent: number;
  rowsSent: number;
  /** Rows the server did not acknowledge (this plan only). */
  rowsUnsent: number;
  error: string | null;
  /** True when the server rejected a payload (4xx): the next run should not just retry blindly. */
  fatal: boolean;
}

/** Halves a chunk, keeping dependency order. */
export function splitChunk(chunk: PlanRows): PlanRows[] {
  return chunkPlan(chunk, Math.ceil(planRowCount(chunk) / 2));
}

/**
 * Uploads a plan chunk by chunk. Stops at the first failure; everything acknowledged before it has
 * already been persisted through `onChunkAcked`. A 413 (too many statements or too large a body)
 * halves the chunk and retries; a single row that is still too large is skipped and reported, and
 * stays dirty locally. An empty plan still sends one empty request so the Worker records a sync
 * run (heartbeat, stats, pending count).
 */
export async function uploadPlan(plan: PlanRows, o: UploadPlanOptions): Promise<UploadOutcome> {
  const url = joinUrl(o.apiUrl, API_ROUTES.ingestUsage);
  const queue = chunkPlan(plan, o.maxRowsPerRequest ?? MAX_ROWS_PER_REQUEST);
  if (!queue.length) queue.push({ buckets: [], sessions: [], projects: [], limitHits: [] });
  const total = planRowCount(plan);
  let sent = 0;
  let chunksSent = 0;
  let skipped = 0;
  let skipError = '';
  let statsSent = !o.stats;
  while (queue.length) {
    const chunk = queue.shift()!;
    const rows = planRowCount(chunk);
    const pending = total - sent - rows + o.pendingAfterPlan;
    // Stats ride on the last chunk only, so each run reports them once.
    const withStats = !queue.length && !statsSent;
    const meta = { device: o.device, version: o.version, pending, ...(withStats ? { stats: o.stats } : {}) };
    const r = await postJson(url, o.writeToken, toIngest(chunk, meta), o);
    if (!r.ok && r.status === 413 && rows > 1) {
      queue.unshift(...splitChunk(chunk));
      continue;
    }
    if (!r.ok && r.status === 413 && rows === 1) {
      skipped++;
      skipError = r.error;
      // Keep the run's stats: send them on an empty request if this was the last chunk.
      if (!queue.length && !statsSent) queue.push({ buckets: [], sessions: [], projects: [], limitHits: [] });
      continue;
    }
    if (!r.ok) return { chunksSent, rowsSent: sent, rowsUnsent: total - sent, error: r.error, fatal: r.fatal };
    if (withStats) statsSent = true;
    o.onChunkAcked(chunk);
    sent += rows;
    chunksSent++;
  }
  const error = skipped ? `${skipped} row(s) too large for the server, skipped: ${skipError}` : null;
  return { chunksSent, rowsSent: sent, rowsUnsent: total - sent, error, fatal: false };
}
