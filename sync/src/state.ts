import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentKind, UnixSeconds, UsageTokens } from '@ccu/shared';

export const STATE_VERSION = 1;
export const PRUNE_AFTER_DAYS = 400;

/** Bit flags in ReqRecord[8]. */
export const FLAG_FINAL = 1;
export const FLAG_FAST = 2;
export const FLAG_GEO_US = 4;

/**
 * Compact deduped request: [ts, dimIndex, input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch, flags].
 * `dimIndex` points into `SyncState.dims`; `flags` holds FLAG_FINAL (has a stop_reason line), FLAG_FAST, FLAG_GEO_US.
 */
export type ReqRecord = [number, number, number, number, number, number, number, number, number];

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
    return {
      ...base,
      ...s,
      uploaded: { ...base.uploaded, ...(s.uploaded ?? {}) },
    } as SyncState;
  } catch {
    return emptyState();
  }
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
  const prev = state.reqs[c.key];
  if (!prev) {
    state.reqs[c.key] = [c.ts, internDim(state, c.dim), t.input, t.output, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h, t.webSearch, flags];
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
