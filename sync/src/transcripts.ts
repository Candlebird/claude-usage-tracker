import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanModelId, isoToUnix, limitWindowKey, SYNTHETIC_MODEL, tokensFromApiUsage } from '@ccu/shared';
import type { AgentKind, ApiUsage, LimitHit, UnixSeconds, UsageTokens } from '@ccu/shared';
import { safeModel, safeProject, safeSessionId, UNKNOWN_ID } from './normalize.js';
import { createProjectResolver, type ProjectResolver } from './projects.js';
import { mergeRequest, type MergeResult, type SessionState, type SyncState } from './state.js';

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export interface TranscriptFile {
  /** Path relative to the projects root, forward slashes (the state key). */
  rel: string;
  abs: string;
  kind: AgentKind;
  /** Session id from the path (the main file name, or the parent session directory). */
  sessionId: string;
  /** Subagent id from `agent-<id>.jsonl`; null for main transcripts. */
  agentId: string | null;
}

const SESSION_FILE = /^(.+)\.jsonl$/;
const AGENT_FILE = /^agent-(.+)\.jsonl$/;
const SKIP_DIRS = new Set(['tool-results', 'memory']);

function dirents(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Collects `agent-*.jsonl` under a session directory (subagents/, subagents/workflows/wf_*, workflows/wf_*). */
function walkAgents(absDir: string, relDir: string, sessionId: string, depth: number, out: TranscriptFile[]): void {
  if (depth > 4) return;
  for (const e of dirents(absDir)) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkAgents(join(absDir, e.name), `${relDir}/${e.name}`, sessionId, depth + 1, out);
      continue;
    }
    const m = AGENT_FILE.exec(e.name);
    if (!m || !e.isFile()) continue;
    const rel = `${relDir}/${e.name}`;
    const kind: AgentKind = rel.split('/').includes('workflows') ? 'workflow' : 'subagent';
    out.push({ rel, abs: join(absDir, e.name), kind, sessionId: safeSessionId(sessionId), agentId: m[1]! });
  }
}

/** Main transcripts and every subagent/workflow transcript under `projectsRoot`. Excludes `journal.jsonl`. */
export function listTranscriptFiles(projectsRoot: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  for (const proj of dirents(projectsRoot)) {
    if (!proj.isDirectory()) continue;
    const projAbs = join(projectsRoot, proj.name);
    for (const e of dirents(projAbs)) {
      if (e.isFile()) {
        const m = SESSION_FILE.exec(e.name);
        if (m) out.push({ rel: `${proj.name}/${e.name}`, abs: join(projAbs, e.name), kind: 'main', sessionId: safeSessionId(m[1]!), agentId: null });
      } else if (e.isDirectory()) {
        walkAgents(join(projAbs, e.name), `${proj.name}/${e.name}`, e.name, 1, out);
      }
    }
  }
  return out;
}

/** `agentType` from the sibling `agent-<id>.meta.json`, if present. */
export function readAgentType(transcriptAbs: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(transcriptAbs.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { agentType?: unknown };
    return typeof meta.agentType === 'string' ? meta.agentType : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/** Everything extracted from one assistant line. */
export interface ParsedRequest {
  key: string;
  requestId: string | null;
  ts: UnixSeconds;
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  /** Cleaned model id (lowercase, no `[1m]`). */
  model: string;
  requestedModel: string | null;
  effort: string | null;
  entrypoint: string | null;
  version: string | null;
  isSidechain: boolean;
  agentKind: AgentKind;
  agentType: string | null;
  agentId: string | null;
  tokens: UsageTokens;
  /** Per-iteration tokens when `usage.iterations` has more than one entry (priced per iteration). */
  iterations: UsageTokens[] | null;
  speed: string | null;
  inferenceGeo: string | null;
  /** The line carries `stop_reason` (the final line of a streamed response). */
  final: boolean;
}

export interface FileContext {
  kind: AgentKind;
  sessionId: string;
  agentId: string | null;
  agentType: string | null;
}

interface RawUsage extends ApiUsage {
  iterations?: ApiUsage[] | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Usage tokens of one line; when the top level is all zero, the sum of `usage.iterations`. */
export function extractTokens(u: RawUsage): UsageTokens {
  const top = tokensFromApiUsage(u);
  const iters = Array.isArray(u.iterations) ? u.iterations : [];
  const topZero = top.input + top.output + top.cacheRead + top.cacheWrite5m + top.cacheWrite1h === 0;
  if (!topZero || iters.length === 0) return top;
  const sum: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: top.webSearch };
  for (const it of iters) {
    if (!it || typeof it !== 'object') continue;
    const t = tokensFromApiUsage(it);
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheRead += t.cacheRead;
    sum.cacheWrite5m += t.cacheWrite5m;
    sum.cacheWrite1h += t.cacheWrite1h;
  }
  return sum;
}

/** Per-iteration tokens when there are at least two iterations, else null. */
export function extractIterations(u: RawUsage): UsageTokens[] | null {
  if (!Array.isArray(u.iterations)) return null;
  const out: UsageTokens[] = [];
  for (const it of u.iterations) if (it && typeof it === 'object') out.push({ ...tokensFromApiUsage(it), webSearch: 0 });
  return out.length > 1 ? out : null;
}

/** Normalizes an epoch that may be in ms to seconds. */
function epochSeconds(v: unknown): UnixSeconds | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return Math.floor(v > 1e12 ? v / 1000 : v);
}

/** A synthetic 429 line's quota info as a limit hit, or null. */
export function extractLimitHit(o: Record<string, any>, ts: UnixSeconds): LimitHit | null {
  const info = (o.quotaLimits ?? o.apiErrorParams?.rate_limit_info) as Record<string, unknown> | undefined;
  if (!info || typeof info !== 'object') return null;
  if (o.apiErrorStatus !== 429 && info.status !== 'rejected') return null;
  return { ts, kind: limitWindowKey(str(info.rateLimitType) ?? 'unknown'), resetsAt: epochSeconds(info.resetsAt) };
}

export type LineResult =
  | { type: 'request'; req: ParsedRequest }
  | { type: 'limitHit'; hit: LimitHit }
  | { type: 'synthetic' }
  | { type: 'skip' };

/** Interprets a parsed `type: "assistant"` line. */
export function parseAssistant(o: Record<string, any>, ctx: FileContext): LineResult {
  const m = o.message;
  if (!m || typeof m !== 'object') return { type: 'skip' };
  const ts = typeof o.timestamp === 'string' ? isoToUnix(o.timestamp) : null;
  if (ts == null) return { type: 'skip' };
  const rawModel = str(m.model);
  if (rawModel === SYNTHETIC_MODEL) {
    const hit = extractLimitHit(o, ts);
    return hit ? { type: 'limitHit', hit } : { type: 'synthetic' };
  }
  const usage = m.usage as RawUsage | undefined;
  if (!usage || typeof usage !== 'object' || !rawModel) return { type: 'skip' };
  const key = str(m.id) ?? str(o.requestId) ?? (str(o.uuid) ? `uuid:${o.uuid}` : null);
  if (!key) return { type: 'skip' };
  return {
    type: 'request',
    req: {
      key,
      requestId: str(o.requestId),
      ts,
      sessionId: safeSessionId(str(o.sessionId) ?? ctx.sessionId),
      cwd: str(o.cwd),
      gitBranch: str(o.gitBranch),
      model: safeModel(cleanModelId(rawModel)),
      requestedModel: str(o.requestedModel),
      effort: str(o.effort) ?? str(o.perTurnEffort),
      entrypoint: str(o.entrypoint),
      version: str(o.version),
      isSidechain: o.isSidechain === true,
      agentKind: ctx.kind,
      agentType: ctx.agentType,
      agentId: str(o.agentId) ?? ctx.agentId,
      tokens: extractTokens(usage),
      iterations: extractIterations(usage),
      speed: str(usage.speed),
      inferenceGeo: str(usage.inference_geo),
      final: m.stop_reason != null,
    },
  };
}

// ---------------------------------------------------------------------------
// Incremental reading
// ---------------------------------------------------------------------------

const PATTERNS = ['"type":"assistant"', '"type":"cost-state"', '"type":"ai-title"'].map((p) => Buffer.from(p));
const BLOB_MARKER = '"type":"api-request-';
const NL = 10;
const CHUNK = 32 * 1024 * 1024;
const HEAD_BYTES = 256;

/** Start offsets of complete lines in buf[0, end) that contain any pre-filter pattern, ascending. */
export function candidateLineStarts(buf: Buffer, end: number): number[] {
  const starts = new Set<number>();
  for (const pat of PATTERNS) {
    let pos = buf.indexOf(pat, 0);
    while (pos >= 0 && pos < end) {
      const start = pos === 0 ? 0 : buf.lastIndexOf(NL, pos - 1) + 1;
      starts.add(start);
      const lineEnd = buf.indexOf(NL, pos);
      if (lineEnd < 0) break;
      pos = buf.indexOf(pat, lineEnd + 1);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

/**
 * Reads complete lines of `abs` from byte `from`, calling `onLine` for candidate lines only.
 * Returns the new offset (just after the last `\n`) and bytes read.
 */
export function readCandidateLines(abs: string, from: number, size: number, onLine: (line: string) => void): { offset: number; bytes: number } {
  const fd = openSync(abs, 'r');
  let offset = from;
  let bytes = 0;
  try {
    let carry: Buffer = Buffer.alloc(0);
    let pos = from;
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const chunk = Buffer.allocUnsafe(want);
      const n = readSync(fd, chunk, 0, want, pos);
      if (n <= 0) break;
      pos += n;
      bytes += n;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const lastNl = buf.lastIndexOf(NL);
      if (lastNl < 0) {
        carry = buf;
        continue;
      }
      const end = lastNl + 1;
      for (const start of candidateLineStarts(buf, end)) {
        const lineEnd = buf.indexOf(NL, start);
        const head = buf.toString('latin1', start, Math.min(lineEnd, start + 200));
        if (head.includes(BLOB_MARKER)) continue;
        onLine(buf.toString('utf8', start, lineEnd));
      }
      offset += end;
      carry = buf.subarray(end);
    }
  } finally {
    closeSync(fd);
  }
  return { offset, bytes };
}

function headFingerprint(abs: string, length: number): string {
  const n = Math.min(HEAD_BYTES, length);
  if (n <= 0) return '';
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return createHash('sha1').update(buf.subarray(0, got)).digest('base64').slice(0, 16);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** cwd -> project resolver (defaults to git-root detection on disk). */
  resolveProject?: ProjectResolver;
  /** Called for every accepted assistant line (after dedupe merge), for verbose output or tests. */
  onRequest?: (req: ParsedRequest, result: MergeResult) => void;
  /** Wall clock, for `state.lastScanTs`. */
  now?: UnixSeconds;
}

export interface ScanStats {
  filesSeen: number;
  filesRead: number;
  filesUnchanged: number;
  /** Files re-read from 0 because they shrank or were replaced. */
  filesReset: number;
  filesRemoved: number;
  bytesRead: number;
  linesParsed: number;
  parseErrors: number;
  assistantLines: number;
  /** Assistant lines that added nothing new (same key, not better). */
  duplicateLines: number;
  syntheticLines: number;
  costStateRecords: number;
  durationMs: number;
}

export interface ScanResult {
  /** Request keys first seen in this scan. */
  newRequests: number;
  /** Existing request keys whose tokens or attribution changed (e.g. the final line arrived). */
  improvedRequests: number;
  /** Session ids touched by this scan. */
  sessions: string[];
  /** Limit hits first seen in this scan. */
  limitHits: LimitHit[];
  stats: ScanStats;
}

function touchSession(state: SyncState, sessionId: string, ts: UnixSeconds | null): SessionState {
  let s = state.sessions[sessionId];
  if (!s) {
    s = {
      project: '',
      projectFromMain: false,
      firstTs: ts ?? 0,
      lastTs: ts ?? 0,
      title: null,
      gitBranch: null,
      models: [],
      agentCount: 0,
      costStateUsd: null,
      linesAdded: null,
      linesRemoved: null,
    };
    state.sessions[sessionId] = s;
  }
  if (ts != null) {
    if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
    if (ts > s.lastTs) s.lastTs = ts;
  }
  return s;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Incrementally parses every transcript under `projectsRoot` into `state` (mutated in place):
 * deduped requests, session metadata, projects and limit hits. Only bytes after each file's
 * stored offset are read, and only complete lines are consumed.
 */
export function scanTranscripts(projectsRoot: string, state: SyncState, opts: ScanOptions = {}): ScanResult {
  const t0 = performance.now();
  const resolve = opts.resolveProject ?? createProjectResolver();
  const stats: ScanStats = {
    filesSeen: 0,
    filesRead: 0,
    filesUnchanged: 0,
    filesReset: 0,
    filesRemoved: 0,
    bytesRead: 0,
    linesParsed: 0,
    parseErrors: 0,
    assistantLines: 0,
    duplicateLines: 0,
    syntheticLines: 0,
    costStateRecords: 0,
    durationMs: 0,
  };
  let newRequests = 0;
  let improvedRequests = 0;
  const touched = new Set<string>();
  const newHits: LimitHit[] = [];

  const files = listTranscriptFiles(projectsRoot);
  const present = new Set<string>();
  for (const f of files) {
    present.add(f.rel);
    stats.filesSeen++;
    let st;
    try {
      st = statSync(f.abs);
    } catch {
      continue;
    }
    const prev = state.files[f.rel];
    if (prev && st.size === prev.size && st.mtimeMs === prev.mtimeMs) {
      stats.filesUnchanged++;
      continue;
    }
    let from = 0;
    if (prev) {
      const sameHead = prev.offset === 0 || headFingerprint(f.abs, Math.min(prev.offset, HEAD_BYTES)) === prev.head;
      if (st.size >= prev.offset && sameHead) from = prev.offset;
      else stats.filesReset++;
    }
    const agentType = f.kind === 'main' ? null : (prev?.agentType ?? readAgentType(f.abs));
    const ctx: FileContext = { kind: f.kind, sessionId: f.sessionId, agentId: f.agentId, agentType };

    const onLine = (line: string) => {
      let o: Record<string, any>;
      try {
        o = JSON.parse(line);
      } catch {
        stats.parseErrors++;
        return;
      }
      stats.linesParsed++;
      if (o.type === 'assistant') {
        stats.assistantLines++;
        const r = parseAssistant(o, ctx);
        if (r.type === 'synthetic') stats.syntheticLines++;
        else if (r.type === 'limitHit') {
          stats.syntheticLines++;
          const id = `${r.hit.ts}|${r.hit.kind}`;
          if (!state.limitHits[id]) {
            state.limitHits[id] = { ts: r.hit.ts, kind: r.hit.kind, resetsAt: r.hit.resetsAt ?? null, uploaded: false };
            newHits.push(r.hit);
          }
        } else if (r.type === 'request') {
          const req = r.req;
          const proj = req.cwd ? resolve(req.cwd) : null;
          const projKey = proj ? safeProject(proj.key) : null;
          const session = touchSession(state, req.sessionId, req.ts);
          if (proj && projKey) {
            if (!state.projects[projKey]) state.projects[projKey] = { path: proj.path };
            if (!session.project || (f.kind === 'main' && !session.projectFromMain)) {
              session.project = projKey;
              session.projectFromMain = f.kind === 'main';
            }
          }
          if (!session.models.includes(req.model)) session.models.push(req.model);
          if (req.gitBranch && (f.kind === 'main' || !session.gitBranch)) session.gitBranch = req.gitBranch;
          touched.add(req.sessionId);
          const result = mergeRequest(state, {
            key: req.key,
            ts: req.ts,
            dim: { project: projKey ?? (session.project || UNKNOWN_ID), model: req.model, agentKind: req.agentKind, sessionId: req.sessionId },
            tokens: req.tokens,
            final: req.final,
            fast: req.speed === 'fast',
            geoUs: req.inferenceGeo === 'us',
            iterations: req.iterations,
          });
          if (result === 'new') newRequests++;
          else if (result === 'improved') improvedRequests++;
          else stats.duplicateLines++;
          opts.onRequest?.(req, result);
        }
      } else if (o.type === 'cost-state') {
        stats.costStateRecords++;
        const sid = safeSessionId(str(o.sessionId) ?? f.sessionId);
        const s = touchSession(state, sid, null);
        s.costStateUsd = numOrNull(o.totalCostUSD) ?? numOrNull(o.costUSD);
        s.linesAdded = numOrNull(o.totalLinesAdded);
        s.linesRemoved = numOrNull(o.totalLinesRemoved);
        touched.add(sid);
      } else if (o.type === 'ai-title') {
        const title = str(o.aiTitle) ?? str(o.title);
        const sid = safeSessionId(str(o.sessionId) ?? f.sessionId);
        if (title) {
          touchSession(state, sid, null).title = title;
          touched.add(sid);
        }
      }
    };

    let res;
    try {
      res = readCandidateLines(f.abs, from, st.size, onLine);
    } catch {
      continue;
    }
    stats.filesRead++;
    stats.bytesRead += res.bytes;
    state.files[f.rel] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      offset: res.offset,
      head: res.offset > 0 ? headFingerprint(f.abs, Math.min(res.offset, HEAD_BYTES)) : '',
      sessionId: f.sessionId,
      kind: f.kind,
      agentType,
    };
  }
  for (const rel of Object.keys(state.files)) {
    if (!present.has(rel)) {
      delete state.files[rel];
      stats.filesRemoved++;
    }
  }
  // Agent count only grows: transcripts purged by Claude Code's cleanup still happened.
  const agents = new Map<string, number>();
  for (const fs of Object.values(state.files)) if (fs.kind !== 'main') agents.set(fs.sessionId, (agents.get(fs.sessionId) ?? 0) + 1);
  for (const [sid, n] of agents) {
    const s = touchSession(state, sid, null);
    if (n > s.agentCount) s.agentCount = n;
  }
  state.lastScanTs = opts.now ?? Math.floor(Date.now() / 1000);
  stats.durationMs = Math.round(performance.now() - t0);
  return { newRequests, improvedRequests, sessions: [...touched], limitHits: newHits, stats };
}
