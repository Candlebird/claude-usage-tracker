import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { limitWindowKey, type AgentKind, type UnixSeconds, type UsageTokens } from '@ccu/shared';

export const STATE_VERSION = 1;
export const PRUNE_AFTER_DAYS = 400;

/** Bit flags in ReqRecord[8]. */
export const FLAG_FINAL = 1;
export const FLAG_FAST = 2;
export const FLAG_GEO_US = 4;

/**
 * Compact deduped request: [ts, dimIndex, input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch, flags, iterations?].
 * `dimIndex` points into `SyncState.dims`; `flags` holds FLAG_FINAL (has a stop_reason line), FLAG_FAST, FLAG_GEO_US.
 * `iterations` is only present when the response had more than one iteration: a flat array of
 * ITERATION_STRIDE numbers per iteration (input, output, cacheRead, cacheWrite5m, cacheWrite1h), so
 * long-context tiers are priced per iteration. Records written before it existed simply lack it.
 */
export type ReqRecord = [number, number, number, number, number, number, number, number, number, number[]?];

/** Numbers per iteration in ReqRecord[9]. */
export const ITERATION_STRIDE = 5;

/** Flattens per-iteration tokens for ReqRecord[9]; undefined when there is at most one iteration. */
export function packIterations(its: readonly UsageTokens[] | null | undefined): number[] | undefined {
  if (!its || its.length < 2) return undefined;
  const out: number[] = [];
  for (const t of its) out.push(t.input, t.output, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h);
  return out;
}

/** Inverse of `packIterations`; webSearch is per request, so it is 0 per iteration. */
export function recordIterations(rec: ReqRecord): UsageTokens[] | undefined {
  const flat = rec[9];
  if (!Array.isArray(flat) || flat.length < 2 * ITERATION_STRIDE) return undefined;
  const out: UsageTokens[] = [];
  for (let i = 0; i + ITERATION_STRIDE <= flat.length; i += ITERATION_STRIDE) {
    out.push({ input: flat[i]!, output: flat[i + 1]!, cacheRead: flat[i + 2]!, cacheWrite5m: flat[i + 3]!, cacheWrite1h: flat[i + 4]!, webSearch: 0 });
  }
  return out;
}

/** Per-transcript-file read position. Keyed by path relative to the projects root, forward slashes. */
export interface FileState {
  size: number;
  mtimeMs: number;
  /** Bytes consumed (always just after a `\n`). */
  offset: number;
  /** Fingerprint of the first bytes, to detect a file replaced in place. */
  head: string;
  sessionId: string;
  kind: AgentKind;
  agentType?: string | null;
}

export interface SessionState {
  project: string;
  /** True once `project` came from the main transcript (it then wins over subagent cwds). */
  projectFromMain: boolean;
  firstTs: UnixSeconds;
  lastTs: UnixSeconds;
  title: string | null;
  gitBranch: string | null;
  models: string[];
  agentCount: number;
  costStateUsd: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}

export interface ProjectState {
  /** Display path (original casing). */
  path: string;
}

export interface LimitHitState {
  ts: UnixSeconds;
  kind: string;
  resetsAt: UnixSeconds | null;
  uploaded: boolean;
}

export interface SyncState {
  version: typeof STATE_VERSION;
  files: Record<string, FileState>;
  /** Interned bucket dimensions: `project\tmodel\tagentKind\tsessionId`. */
  dims: string[];
  /** Deduped requests keyed by message.id (fallback requestId). */
  reqs: Record<string, ReqRecord>;
  sessions: Record<string, SessionState>;
  projects: Record<string, ProjectState>;
  /** Keyed by `${ts}|${kind}`. */
  limitHits: Record<string, LimitHitState>;
  /** Hash of the last successfully uploaded value per row id. */
  uploaded: {
    buckets: Record<string, string>;
    sessions: Record<string, string>;
    projects: Record<string, string>;
  };
  lastScanTs: UnixSeconds | null;
  /** Rows acknowledged by the server on one UTC day, for the per-day write budget. */
  rowsToday: RowsToday;
}

export interface RowsToday {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  rows: number;
}

export interface Dim {
  project: string;
  model: string;
  agentKind: AgentKind;
  sessionId: string;
}

export function emptyState(): SyncState {
  return {
    version: STATE_VERSION,
    files: {},
    dims: [],
    reqs: {},
    sessions: {},
    projects: {},
    limitHits: {},
    uploaded: { buckets: {}, sessions: {}, projects: {} },
    lastScanTs: null,
    rowsToday: { day: '', rows: 0 },
  };
}

/** Reads state; returns a fresh state when the file is missing, unreadable or from another version. */
export function loadState(path: string): SyncState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return emptyState();
  }
  try {
    const s = JSON.parse(raw) as Partial<SyncState>;
    if (s.version !== STATE_VERSION) return emptyState();
    const base = emptyState();
    const state = {
      ...base,
      ...s,
      uploaded: { ...base.uploaded, ...(s.uploaded ?? {}) },
    } as SyncState;
    const rt = s.rowsToday;
    state.rowsToday = rt && typeof rt.day === 'string' && Number.isFinite(rt.rows) ? { day: rt.day, rows: rt.rows } : { ...base.rowsToday };
    normalizeLimitHits(state);
    return state;
  } catch {
    return emptyState();
  }
}

/**
 * Re-keys limit hits stored before kinds were normalized (`seven_day_opus` -> `seven_day:opus`).
 * Keeps the `uploaded` flag, so already-uploaded hits are not re-sent; the Worker migrates its rows.
 */
export function normalizeLimitHits(state: SyncState): void {
  for (const [id, h] of Object.entries(state.limitHits)) {
    const kind = limitWindowKey(h.kind);
    const nid = `${h.ts}|${kind}`;
    if (kind === h.kind && nid === id) continue;
    delete state.limitHits[id];
    const twin = state.limitHits[nid];
    state.limitHits[nid] = twin
      ? { ...twin, resetsAt: twin.resetsAt ?? h.resetsAt, uploaded: twin.uploaded && h.uploaded }
      : { ...h, kind };
  }
}

// ---------------------------------------------------------------------------
// Per-UTC-day row budget
// ---------------------------------------------------------------------------

export function utcDay(now: UnixSeconds): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/** Rows already written today (UTC); 0 once the day rolled over. */
export function rowsWrittenToday(state: SyncState, now: UnixSeconds): number {
  return state.rowsToday.day === utcDay(now) ? state.rowsToday.rows : 0;
}

/** Adds acknowledged rows to today's counter, resetting it on a new UTC day. */
export function addRowsWritten(state: SyncState, rows: number, now: UnixSeconds): void {
  const day = utcDay(now);
  state.rowsToday = { day, rows: (state.rowsToday.day === day ? state.rowsToday.rows : 0) + rows };
}

/** Rows this run may write: the per-run cap, further limited by what is left of the daily budget. */
export function rowBudget(state: SyncState, now: UnixSeconds, perRun: number, perDay: number): number {
  return Math.max(0, Math.min(perRun, perDay - rowsWrittenToday(state, now)));
}

/** Atomic write (temp file + rename). */
export function saveState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), 'utf8');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Dimension interning (the reverse index is rebuilt lazily, never persisted)
// ---------------------------------------------------------------------------

const dimIndexes = new WeakMap<SyncState, Map<string, number>>();

export function dimKey(d: Dim): string {
  return `${d.project}\t${d.model}\t${d.agentKind}\t${d.sessionId}`;
}

export function parseDim(key: string): Dim {
  const [project = '', model = '', agentKind = 'main', sessionId = ''] = key.split('\t');
  return { project, model, agentKind: agentKind as AgentKind, sessionId };
}

export function internDim(state: SyncState, d: Dim): number {
  let idx = dimIndexes.get(state);
  if (!idx || idx.size !== state.dims.length) {
    idx = new Map(state.dims.map((k, i) => [k, i]));
    dimIndexes.set(state, idx);
  }
  const key = dimKey(d);
  let i = idx.get(key);
  if (i === undefined) {
    i = state.dims.length;
    state.dims.push(key);
    idx.set(key, i);
  }
  return i;
}

export function dimOf(state: SyncState, rec: ReqRecord): Dim {
  return parseDim(state.dims[rec[1]] ?? '');
}

export function recordTokens(rec: ReqRecord): UsageTokens {
  return { input: rec[2], output: rec[3], cacheRead: rec[4], cacheWrite5m: rec[5], cacheWrite1h: rec[6], webSearch: rec[7] };
}

// ---------------------------------------------------------------------------
// Request merge (the dedupe rule)
// ---------------------------------------------------------------------------

export interface RequestCandidate {
  key: string;
  ts: UnixSeconds;
  dim: Dim;
  tokens: UsageTokens;
  final: boolean;
  fast: boolean;
  geoUs: boolean;
  /** Per-iteration tokens when the response had more than one iteration. */
  iterations?: readonly UsageTokens[] | null;
}

export type MergeResult = 'new' | 'improved' | 'duplicate';

/**
 * Upserts one assistant line into the deduped request table.
 * Tokens: a final line (stop_reason set) beats a non-final one; otherwise the higher output wins.
 * Attribution: a main-transcript occurrence beats a subagent/workflow one; otherwise the earliest ts wins.
 */
export function mergeRequest(state: SyncState, c: RequestCandidate): MergeResult {
  const flags = (c.final ? FLAG_FINAL : 0) | (c.fast ? FLAG_FAST : 0) | (c.geoUs ? FLAG_GEO_US : 0);
  const t = c.tokens;
  const its = packIterations(c.iterations);
  const prev = state.reqs[c.key];
  if (!prev) {
    const rec: ReqRecord = [c.ts, internDim(state, c.dim), t.input, t.output, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h, t.webSearch, flags];
    if (its) rec[9] = its;
    state.reqs[c.key] = rec;
    return 'new';
  }
  let changed = false;
  const prevFinal = (prev[8] & FLAG_FINAL) !== 0;
  if ((c.final && !prevFinal) || (c.final === prevFinal && t.output > prev[3])) {
    prev[2] = t.input;
    prev[3] = t.output;
    prev[4] = t.cacheRead;
    prev[5] = t.cacheWrite5m;
    prev[6] = t.cacheWrite1h;
    prev[7] = t.webSearch;
    prev[8] = flags;
    // Iterations travel with the winning tokens.
    if (its) prev[9] = its;
    else if (prev.length > 9) prev.length = 9;
    changed = true;
  }
  const prevMain = parseDim(state.dims[prev[1]] ?? '').agentKind === 'main';
  const candMain = c.dim.agentKind === 'main';
  if ((candMain && !prevMain) || (candMain === prevMain && c.ts < prev[0])) {
    const i = internDim(state, c.dim);
    if (i !== prev[1] || c.ts !== prev[0]) changed = true;
    // ts travels with the winning attribution, so the request lands in that occurrence's hour.
    prev[1] = i;
    prev[0] = c.ts;
  }
  return changed ? 'improved' : 'duplicate';
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/** Start of the oldest UTC hour still kept by `pruneState`. */
export function pruneHourCutoff(now: UnixSeconds, days = PRUNE_AFTER_DAYS): UnixSeconds {
  return Math.floor((now - days * 86400) / 3600) * 3600;
}

/**
 * Drops requests, sessions, hits and upload hashes older than `days`, then compacts `dims`.
 * Requests and bucket hashes are cut on the same hour boundary: an hour is either fully kept or
 * fully forgotten, so the client never re-sends a partial (or zeroed) hour the server already has.
 */
export function pruneState(state: SyncState, now: UnixSeconds, days = PRUNE_AFTER_DAYS): void {
  const hourCutoff = pruneHourCutoff(now, days);
  for (const [k, r] of Object.entries(state.reqs)) if (r[0] < hourCutoff) delete state.reqs[k];
  for (const [k, s] of Object.entries(state.sessions)) {
    if (s.lastTs < hourCutoff) {
      delete state.sessions[k];
      delete state.uploaded.sessions[k];
    }
  }
  for (const [k, h] of Object.entries(state.limitHits)) if (h.ts < hourCutoff) delete state.limitHits[k];
  for (const k of Object.keys(state.uploaded.buckets)) {
    if (Number(k.slice(0, k.indexOf('\t'))) < hourCutoff) delete state.uploaded.buckets[k];
  }
  compactDims(state);
}

/** Removes dims no request references. Bucket ids embed the dim text, not its index, so upload hashes stay valid. */
export function compactDims(state: SyncState): void {
  const used = new Map<number, number>();
  const dims: string[] = [];
  for (const r of Object.values(state.reqs)) {
    let n = used.get(r[1]);
    if (n === undefined) {
      n = dims.length;
      dims.push(state.dims[r[1]]!);
      used.set(r[1], n);
    }
    r[1] = n;
  }
  state.dims = dims;
  dimIndexes.delete(state);
}
