/**
 * Local aggregation: deduped request state -> hourly buckets, session/project metadata, and the
 * per-run upload plan. Everything here is a pure function of `SyncState` (plus a clock).
 *
 * API for the CLI (`ccu sync`):
 *
 *   const state = loadState(paths.stateFile);                        // state.ts
 *   const scan = scanTranscripts(paths.projectsDir, state);           // transcripts.ts
 *     // -> { newRequests, improvedRequests, sessions, limitHits, stats }
 *   pruneState(state, now);                                           // state.ts (400 days)
 *   const buckets = buildBuckets(state);                              // Map<bucketId, HourlyBucket>
 *   const dirty = diffDirty(state, buckets);                          // changed + vanished (zero) rows, newest first
 *   const plan = planUpload(state, { maxRows, sinceTs, buckets });    // row budget, newest first
 *     // -> { buckets, sessions, projects, limitHits, rows, pending }
 *   // POST plan as UsageIngest (pending = plan.pending); on 2xx:
 *   markPlanUploaded(state, plan);   // or markUploaded / markSessionsUploaded / ... individually
 *   saveState(paths.stateFile, state);
 *
 *   computeToday(state, tz, now)      // -> { costUsd, tokens, requests } for the local calendar day
 *   burnRatePerHour(state, now)       // USD over the last 3600 s
 *   outputIncompleteCount(state), unpricedModels(state)   // SyncRunStats
 *
 * A bucket's id is `${hour}\t${project}\t${model}\t${agentKind}\t${sessionId}`; its hash covers
 * every uploaded value (cost rounded to 6 decimals), so unchanged buckets are never re-sent.
 */
import { createHash } from 'node:crypto';
import { costOf, dayBounds, dayKey, hourStartUtc, isPriced } from '@ccu/shared';
import type { HourlyBucket, LimitHit, ProjectMeta, SessionMeta, UnixSeconds } from '@ccu/shared';
import { ARRAY_LIMITS, DEFAULT_MAX_ROWS_PER_RUN, STRING_LIMITS } from '@ccu/shared';
import { UNKNOWN_ID } from './normalize.js';
import { labelProjects } from './projects.js';
import { FLAG_FAST, FLAG_FINAL, FLAG_GEO_US, parseDim, recordIterations, recordTokens, type ReqRecord, type SyncState } from './state.js';

export { loadState, saveState } from './state.js';
export { scanTranscripts } from './transcripts.js';

const COST_DECIMALS = 6;

/** Labels are display-only; keep the most specific (trailing) part when one is overlong. */
const clampLabel = (s: string) => {
  const t = s.trim();
  return t.length > STRING_LIMITS.label ? `…${t.slice(-(STRING_LIMITS.label - 1))}` : t;
};

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('base64').slice(0, 12);
}

/** API-equivalent cost of one stored request. */
export function requestCost(rec: ReqRecord, model: string): number {
  return costOf(recordTokens(rec), model, {
    speed: rec[8] & FLAG_FAST ? 'fast' : null,
    inferenceGeo: rec[8] & FLAG_GEO_US ? 'us' : null,
    iterations: recordIterations(rec),
  });
}

/** Model per dim index, parsed once per call. */
function modelLookup(state: SyncState): (i: number) => string {
  const cache = new Map<number, string>();
  return (i) => {
    let m = cache.get(i);
    if (m === undefined) {
      m = parseDim(state.dims[i] ?? '').model;
      cache.set(i, m);
    }
    return m;
  };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export function bucketId(b: Pick<HourlyBucket, 'hour' | 'project' | 'model' | 'agentKind' | 'sessionId'>): string {
  return `${b.hour}\t${b.project}\t${b.model}\t${b.agentKind}\t${b.sessionId}`;
}

export function bucketHash(b: HourlyBucket): string {
  return shortHash(
    [b.requests, b.input, b.output, b.cacheRead, b.cacheWrite5m, b.cacheWrite1h, b.webSearch, b.costUsd.toFixed(COST_DECIMALS)].join(','),
  );
}

function roundCost(v: number): number {
  return Number(v.toFixed(COST_DECIMALS));
}

/**
 * Sums every stored request into UTC-hour buckets keyed by `bucketId`. Hours are UTC by contract
 * (the server buckets days by tz at query time), so no timezone is needed here.
 */
export function buildBuckets(state: SyncState, _tz?: string): Map<string, HourlyBucket> {
  const out = new Map<string, HourlyBucket>();
  const dims = state.dims.map(parseDim);
  for (const rec of Object.values(state.reqs)) {
    const d = dims[rec[1]];
    if (!d) continue;
    const hour = hourStartUtc(rec[0]);
    const id = `${hour}\t${state.dims[rec[1]]}`;
    let b = out.get(id);
    if (!b) {
      b = { hour, project: d.project, model: d.model, agentKind: d.agentKind, sessionId: d.sessionId, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, costUsd: 0 };
      out.set(id, b);
    }
    b.requests++;
    b.input += rec[2];
    b.output += rec[3];
    b.cacheRead += rec[4];
    b.cacheWrite5m += rec[5];
    b.cacheWrite1h += rec[6];
    b.webSearch += rec[7];
    b.costUsd += requestCost(rec, d.model);
  }
  for (const b of out.values()) b.costUsd = roundCost(b.costUsd);
  return out;
}

function zeroBucket(id: string): HourlyBucket | null {
  const [hour, project = '', model = '', agentKind = 'main', sessionId = ''] = id.split('\t');
  const h = Number(hour);
  if (!Number.isFinite(h)) return null;
  return { hour: h, project, model, agentKind: agentKind as HourlyBucket['agentKind'], sessionId, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, costUsd: 0 };
}

/**
 * Buckets whose values differ from the last successful upload, newest hour first. A bucket that was
 * uploaded but no longer exists (e.g. a request was re-attributed to its parent session) is emitted
 * as an all-zero row so the server copy is corrected.
 */
export function diffDirty(state: SyncState, buckets: Map<string, HourlyBucket>): HourlyBucket[] {
  const dirty: HourlyBucket[] = [];
  for (const [id, b] of buckets) if (state.uploaded.buckets[id] !== bucketHash(b)) dirty.push(b);
  for (const id of Object.keys(state.uploaded.buckets)) {
    if (buckets.has(id)) continue;
    const z = zeroBucket(id);
    if (z) dirty.push(z);
  }
  return dirty.sort((a, b) => b.hour - a.hour);
}

/** Records uploaded bucket rows; a zero row clears its hash (nothing left to track). */
export function markUploaded(state: SyncState, rows: readonly HourlyBucket[]): void {
  for (const b of rows) {
    const id = bucketId(b);
    if (b.requests === 0) delete state.uploaded.buckets[id];
    else state.uploaded.buckets[id] = bucketHash(b);
  }
}

// ---------------------------------------------------------------------------
// Sessions and projects
// ---------------------------------------------------------------------------

/** Session metadata for sessions with at least one timestamped record. */
export function buildSessions(state: SyncState): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const [sessionId, s] of Object.entries(state.sessions)) {
    if (!s.firstTs) continue;
    out.push({
      sessionId,
      project: s.project || UNKNOWN_ID,
      title: s.title,
      gitBranch: s.gitBranch,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      models: [...s.models].sort().slice(0, ARRAY_LIMITS.modelsPerSession),
      agentCount: s.agentCount,
      costStateUsd: s.costStateUsd,
      linesAdded: s.linesAdded,
      linesRemoved: s.linesRemoved,
    });
  }
  return out.sort((a, b) => b.lastTs - a.lastTs);
}

const sessionHash = (s: SessionMeta) => shortHash(JSON.stringify(s));

export function diffDirtySessions(state: SyncState, sessions: readonly SessionMeta[]): SessionMeta[] {
  return sessions.filter((s) => state.uploaded.sessions[s.sessionId] !== sessionHash(s));
}

export function markSessionsUploaded(state: SyncState, sessions: readonly SessionMeta[]): void {
  for (const s of sessions) state.uploaded.sessions[s.sessionId] = sessionHash(s);
}

/** Every known project with its collision-free display label. */
export function buildProjects(state: SyncState): ProjectMeta[] {
  const refs = Object.entries(state.projects).map(([key, p]) => ({ key, path: p.path }));
  const labels = labelProjects(refs);
  return refs.map((r) => ({ project: r.key, label: clampLabel(labels.get(r.key) ?? r.path) || UNKNOWN_ID, path: r.path }));
}

const projectHash = (p: ProjectMeta) => shortHash(`${p.label}\n${p.path ?? ''}`);

export function diffDirtyProjects(state: SyncState, projects: readonly ProjectMeta[]): ProjectMeta[] {
  return projects.filter((p) => state.uploaded.projects[p.project] !== projectHash(p));
}

export function markProjectsUploaded(state: SyncState, projects: readonly ProjectMeta[]): void {
  for (const p of projects) state.uploaded.projects[p.project] = projectHash(p);
}

// ---------------------------------------------------------------------------
// Limit hits
// ---------------------------------------------------------------------------

export function pendingLimitHits(state: SyncState): LimitHit[] {
  return Object.values(state.limitHits)
    .filter((h) => !h.uploaded)
    .map((h) => ({ ts: h.ts, kind: h.kind, resetsAt: h.resetsAt }))
    .sort((a, b) => b.ts - a.ts);
}

export function markLimitHitsUploaded(state: SyncState, hits: readonly LimitHit[]): void {
  for (const h of hits) {
    const s = state.limitHits[`${h.ts}|${h.kind}`];
    if (s) s.uploaded = true;
  }
}

// ---------------------------------------------------------------------------
// Upload plan (free-tier row budget)
// ---------------------------------------------------------------------------

export interface PlanOptions {
  /** Max rows (buckets + sessions + projects + hits) in this run. */
  maxRows?: number;
  /** Ignore buckets before this hour and sessions that ended before it (`ccu backfill --days N`). */
  sinceTs?: UnixSeconds | null;
  /** Prebuilt buckets, to avoid rebuilding. */
  buckets?: Map<string, HourlyBucket>;
}

export interface UploadPlan {
  buckets: HourlyBucket[];
  sessions: SessionMeta[];
  projects: ProjectMeta[];
  limitHits: LimitHit[];
  /** Rows in this plan. */
  rows: number;
  /** Dirty rows left for a later run (inside the `sinceTs` window). */
  pending: number;
  /** Dirty buckets older than `sinceTs`, not counted in `pending`. */
  outsideWindow: number;
}

/**
 * Picks what to upload this run within `maxRows`: projects, limit hits and sessions first
 * (small and referenced by buckets), then dirty buckets newest hour first.
 */
export function planUpload(state: SyncState, opts: PlanOptions = {}): UploadPlan {
  const maxRows = Math.max(0, opts.maxRows ?? DEFAULT_MAX_ROWS_PER_RUN);
  const since = opts.sinceTs ?? null;
  let budget = maxRows;
  const take = <T>(items: readonly T[]): T[] => {
    const n = Math.min(budget, items.length);
    budget -= n;
    return items.slice(0, n);
  };

  const dirtyProjects = diffDirtyProjects(state, buildProjects(state));
  const hits = pendingLimitHits(state).filter((h) => since == null || h.ts >= since);
  const dirtySessions = diffDirtySessions(state, buildSessions(state)).filter((s) => since == null || s.lastTs >= since);
  const allBuckets = diffDirty(state, opts.buckets ?? buildBuckets(state));
  const sinceHour = since == null ? null : hourStartUtc(since);
  const inWindow = sinceHour == null ? allBuckets : allBuckets.filter((b) => b.hour >= sinceHour);

  const projects = take(dirtyProjects);
  const limitHits = take(hits);
  const sessions = take(dirtySessions);
  const buckets = take(inWindow);
  const rows = projects.length + limitHits.length + sessions.length + buckets.length;
  const total = dirtyProjects.length + hits.length + dirtySessions.length + inWindow.length;
  return { buckets, sessions, projects, limitHits, rows, pending: total - rows, outsideWindow: allBuckets.length - inWindow.length };
}

/** Marks everything in a plan as uploaded (call only after a 2xx response). */
export function markPlanUploaded(state: SyncState, plan: Pick<UploadPlan, 'buckets' | 'sessions' | 'projects' | 'limitHits'>): void {
  markUploaded(state, plan.buckets);
  markSessionsUploaded(state, plan.sessions);
  markProjectsUploaded(state, plan.projects);
  markLimitHitsUploaded(state, plan.limitHits);
}

// ---------------------------------------------------------------------------
// Local summaries (statusline cache, health stats)
// ---------------------------------------------------------------------------

export interface TodayTotals {
  costUsd: number;
  tokens: number;
  requests: number;
}

/** Totals for the local calendar day containing `now` in `tz`. */
export function computeToday(state: SyncState, tz: string, now: UnixSeconds): TodayTotals {
  const { start, end } = dayBounds(dayKey(now, tz), tz);
  const model = modelLookup(state);
  const t: TodayTotals = { costUsd: 0, tokens: 0, requests: 0 };
  for (const rec of Object.values(state.reqs)) {
    if (rec[0] < start || rec[0] >= end) continue;
    t.requests++;
    t.tokens += rec[2] + rec[3] + rec[4] + rec[5] + rec[6];
    t.costUsd += requestCost(rec, model(rec[1]));
  }
  t.costUsd = roundCost(t.costUsd);
  return t;
}

/** API-equivalent USD spent in the last hour (`(now - 3600, now]`). */
export function burnRatePerHour(state: SyncState, now: UnixSeconds): number {
  const model = modelLookup(state);
  let cost = 0;
  for (const rec of Object.values(state.reqs)) {
    if (rec[0] > now - 3600 && rec[0] <= now) cost += requestCost(rec, model(rec[1]));
  }
  return roundCost(cost);
}

/** Requests stored without a final (`stop_reason`) line: their output is likely undercounted. */
export function outputIncompleteCount(state: SyncState): number {
  let n = 0;
  for (const rec of Object.values(state.reqs)) if (!(rec[8] & FLAG_FINAL)) n++;
  return n;
}

/** Distinct stored model ids with no price in the shared table. */
export function unpricedModels(state: SyncState): string[] {
  const models = new Set<string>();
  for (const k of state.dims) models.add(parseDim(k).model);
  return [...models].filter((m) => !isPriced(m)).sort();
}
