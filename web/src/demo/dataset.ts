import {
  DAY,
  FIVE_HOUR_SECONDS,
  HOUR,
  MINUTE,
  SEVEN_DAY_SECONDS,
  addDays,
  costOf,
  dayKey,
  dayKeyStart,
  dayOfWeek,
  emptyUsage,
  type AgentKind,
  type HourlyBucket,
  type LimitHit,
  type LiveRequest,
  type ProjectMeta,
  type SessionMeta,
  type UnixSeconds,
  type UsageTokens,
} from '@ccu/shared';
import { fakeUuid, rngFor, type Rng } from './rng';

/**
 * A synthetic, deterministic usage history: 90 days of sessions across a handful of
 * made-up projects. Everything is derived from seeded randomness keyed by calendar day
 * (in `tz`) or absolute minute, so reloading the page shows the same numbers.
 */

export const DEMO_DAYS = 90;
export const DEMO_DEVICE = 'demo-workstation';
export const DEMO_VERSION = '2.0.0-demo';

export const MODELS = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  opusOld: 'claude-opus-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const;

export const DEMO_PROJECTS: ProjectMeta[] = [
  { project: 'c:/dev/orbit-api', label: 'orbit-api', path: 'C:/dev/orbit-api' },
  { project: 'c:/dev/lumen-web', label: 'lumen-web', path: 'C:/dev/lumen-web' },
  { project: 'c:/dev/harbor-sync', label: 'harbor-sync', path: 'C:/dev/harbor-sync' },
  { project: 'c:/dev/pixel-forge', label: 'pixel-forge', path: 'C:/dev/pixel-forge' },
  { project: 'c:/dev/notes-cli', label: 'notes-cli', path: 'C:/dev/notes-cli' },
  { project: 'c:/dev/infra-scripts', label: 'infra-scripts', path: 'C:/dev/infra-scripts' },
];
const PROJECT_WEIGHTS = [5, 4, 3, 2.5, 1.5, 1];

const TITLES = [
  'Refactor request retry policy',
  'Add pagination to search endpoint',
  'Fix flaky integration test',
  'Migrate settings page to new form kit',
  'Investigate slow cold start',
  'Write release notes draft',
  'Port parser to streaming API',
  'Tighten input validation',
  'Add dark mode tokens',
  'Profile render loop',
  'Design schema for audit log',
  'Upgrade bundler and fix warnings',
  'Draft onboarding checklist',
  'Clean up dead feature flags',
  'Implement export to CSV',
  'Review error handling in sync worker',
];
const BRANCHES = ['main', 'main', 'feat/pagination', 'fix/retry', 'chore/deps', 'feat/export', 'spike/streaming'];

/** Plan capacity used by the synthetic limit windows (USD of API-equivalent cost per 1%). */
export const FIVE_HOUR_USD_PER_PCT = 0.3;
export const WEEKLY_USD_PER_PCT = 3.2;
export const FABLE_WEEKLY_USD_PER_PCT = 1.6;
/** Weekly windows reset Thursdays 17:00 UTC (any fixed anchor works). */
const WEEKLY_ANCHOR: UnixSeconds = Date.UTC(2026, 0, 1, 17, 0, 0) / 1000;

export interface DemoDataset {
  now: UnixSeconds;
  tz: string;
  buckets: HourlyBucket[];
  sessions: SessionMeta[];
  projects: ProjectMeta[];
  hits: LimitHit[];
  blocks: DemoBlock[];
  live: LiveRequest[];
  /** Cost per UTC hour start, all models and Fable only (for limit windows). */
  hourCost: Map<UnixSeconds, { all: number; fable: number }>;
}

export interface DemoBlock {
  start: UnixSeconds;
  end: UnixSeconds;
  usdPerPct: number;
}

interface SessionPlan {
  meta: SessionMeta;
  mainModel: string;
  intensity: number;
  workflow: boolean;
}

/** The weekly reset that follows `ts`. */
export function weeklyResetAfter(ts: UnixSeconds): UnixSeconds {
  const k = Math.floor((ts - WEEKLY_ANCHOR) / SEVEN_DAY_SECONDS) + 1;
  return WEEKLY_ANCHOR + k * SEVEN_DAY_SECONDS;
}

function mainModelFor(r: Rng, daysAgo: number): string {
  const opus = daysAgo > 50 ? MODELS.opusOld : MODELS.opus;
  return r.weighted([MODELS.fable, opus, MODELS.sonnet], [0.3, 0.5, 0.2]);
}

function planDay(day: string, tz: string, daysAgo: number): SessionPlan[] {
  const r = rngFor('day', day);
  const dayStart = dayKeyStart(day, tz);
  const dow = dayOfWeek(dayStart + 12 * HOUR, tz);
  const weekend = dow === 0 || dow === 6;
  // A gentle upward trend toward the present, plus occasional heavy days.
  const trend = 0.75 + 0.35 * (1 - daysAgo / DEMO_DAYS);
  const count = weekend ? r.int(0, 2) : r.int(2, 6);
  const heavy = !weekend && r.chance(0.12);
  const plans: SessionPlan[] = [];
  for (let i = 0; i < count; i++) {
    const startHour = r.weighted([8, 9, 10, 11, 13, 14, 15, 16, 19, 21, 22], [2, 4, 4, 3, 3, 4, 3, 2, 2, 1.5, 1]);
    const firstTs = dayStart + startHour * HOUR + r.int(0, 50) * MINUTE;
    const durationSec = Math.round(r.range(0.4, heavy ? 4.5 : 3.2) * HOUR);
    const project = r.weighted(DEMO_PROJECTS, PROJECT_WEIGHTS).project;
    const mainModel = mainModelFor(r, daysAgo);
    const workflow = r.chance(heavy ? 0.5 : 0.12);
    const sessionId = fakeUuid('session', day, i);
    plans.push({
      mainModel,
      workflow,
      intensity: trend * (heavy ? 1.7 : 1) * r.jitter(0.35),
      meta: {
        sessionId,
        project,
        title: r.chance(0.92) ? r.pick(TITLES) : null,
        gitBranch: r.pick(BRANCHES),
        firstTs,
        lastTs: firstTs + durationSec,
        models: [],
        agentCount: 0,
        costStateUsd: null,
        linesAdded: r.chance(0.8) ? r.int(5, 900) : null,
        linesRemoved: null,
      },
    });
  }
  return plans;
}

/** Always-present session that is running right now, so live views have content. */
function liveSessionPlan(now: UnixSeconds): SessionPlan {
  const r = rngFor('live-session', Math.floor(now / DAY));
  const firstTs = now - 95 * MINUTE;
  return {
    mainModel: MODELS.opus,
    workflow: false,
    intensity: 1.1,
    meta: {
      sessionId: fakeUuid('live-session', Math.floor(now / DAY)),
      project: DEMO_PROJECTS[0]!.project,
      title: 'Add pagination to search endpoint',
      gitBranch: 'feat/pagination',
      firstTs,
      lastTs: now - 20,
      models: [],
      agentCount: 0,
      costStateUsd: null,
      linesAdded: r.int(40, 300),
      linesRemoved: null,
    },
  };
}

function requestTokens(r: Rng, model: string, kind: AgentKind, n: number): UsageTokens {
  const u = emptyUsage();
  const small = model === MODELS.haiku;
  // Cache-heavy, like real agentic sessions: large cached context, small fresh input.
  u.input = Math.round(n * r.range(15, 140));
  u.output = Math.round(n * r.range(small ? 150 : 350, small ? 700 : 1500));
  u.cacheRead = Math.round(n * r.range(kind === 'main' ? 45_000 : 18_000, kind === 'main' ? 110_000 : 50_000));
  u.cacheWrite5m = Math.round(n * r.range(600, 2600));
  u.cacheWrite1h = kind === 'main' ? Math.round(n * r.range(200, 1600)) : 0;
  u.webSearch = r.chance(0.08) ? r.int(1, 4) : 0;
  return u;
}

/** Prices a bucket as `n` average-sized requests (tiers depend on per-request size). */
function bucketCost(u: UsageTokens, model: string, n: number): number {
  if (n <= 0) return 0;
  const per: UsageTokens = {
    input: u.input / n,
    output: u.output / n,
    cacheRead: u.cacheRead / n,
    cacheWrite5m: u.cacheWrite5m / n,
    cacheWrite1h: u.cacheWrite1h / n,
    webSearch: 0,
  };
  return costOf(per, model) * n + u.webSearch * 0.01;
}

function addBucket(
  out: HourlyBucket[],
  r: Rng,
  plan: SessionPlan,
  hour: UnixSeconds,
  fraction: number,
  model: string,
  kind: AgentKind,
  baseRequests: number,
): void {
  const requests = Math.max(1, Math.round(baseRequests * fraction * plan.intensity * r.jitter(0.3)));
  const u = requestTokens(r, model, kind, requests);
  out.push({ hour, project: plan.meta.project, model, agentKind: kind, sessionId: plan.meta.sessionId, requests, costUsd: bucketCost(u, model, requests), ...u });
}

function sessionBuckets(plan: SessionPlan, now: UnixSeconds): HourlyBucket[] {
  const out: HourlyBucket[] = [];
  const m = plan.meta;
  const end = Math.min(m.lastTs, now);
  if (end <= m.firstTs) return out;
  const r = rngFor('buckets', m.sessionId);
  for (let h = Math.floor(m.firstTs / HOUR) * HOUR; h < end; h += HOUR) {
    const fraction = (Math.min(end, h + HOUR) - Math.max(m.firstTs, h)) / HOUR;
    if (fraction <= 0) continue;
    addBucket(out, r, plan, h, fraction, plan.mainModel, 'main', 55);
    if (r.chance(0.55)) addBucket(out, r, plan, h, fraction, r.weighted([MODELS.haiku, MODELS.sonnet], [0.65, 0.35]), 'subagent', 22);
    if (plan.workflow && r.chance(0.7)) addBucket(out, r, plan, h, fraction, r.weighted([MODELS.opus, MODELS.sonnet], [0.6, 0.4]), 'workflow', 40);
  }
  return out;
}

function finishSessionMeta(plan: SessionPlan, buckets: HourlyBucket[], now: UnixSeconds): SessionMeta {
  const r = rngFor('meta', plan.meta.sessionId);
  const models = [...new Set(buckets.map((b) => b.model))];
  const cost = buckets.reduce((s, b) => s + b.costUsd, 0);
  const subagentHours = buckets.filter((b) => b.agentKind === 'subagent').length;
  const workflowHours = buckets.filter((b) => b.agentKind === 'workflow').length;
  const added = plan.meta.linesAdded ?? null;
  return {
    ...plan.meta,
    lastTs: Math.min(plan.meta.lastTs, now),
    models,
    agentCount: subagentHours * r.int(1, 3) + workflowHours * r.int(2, 6),
    // Claude Code's own total runs a little higher (titles, classifiers, compaction).
    costStateUsd: r.chance(0.85) ? cost * r.range(1.01, 1.07) : null,
    linesRemoved: added == null ? null : Math.round(added * r.range(0.1, 0.7)),
  };
}

/** Rebuilds 5-hour blocks the way the plan does: a block opens on the first request after the last one closed. */
function buildBlocks(hourCost: Map<UnixSeconds, { all: number; fable: number }>, firstActivity: Map<UnixSeconds, UnixSeconds>): DemoBlock[] {
  const hours = [...hourCost.keys()].sort((a, b) => a - b);
  const blocks: DemoBlock[] = [];
  let end = -Infinity;
  for (const h of hours) {
    const first = firstActivity.get(h) ?? h;
    if (first < end) continue;
    const start = Math.floor(first / MINUTE) * MINUTE;
    end = start + FIVE_HOUR_SECONDS;
    blocks.push({ start, end, usdPerPct: FIVE_HOUR_USD_PER_PCT * rngFor('block', start).jitter(0.12) });
  }
  return blocks;
}

/** Cost of the hours in `[from, to)`, prorating partial hours. */
export function costBetween(hourCost: Map<UnixSeconds, { all: number; fable: number }>, from: UnixSeconds, to: UnixSeconds, which: 'all' | 'fable' = 'all'): number {
  let sum = 0;
  for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) {
    const c = hourCost.get(h);
    if (!c) continue;
    const overlap = (Math.min(to, h + HOUR) - Math.max(from, h)) / HOUR;
    if (overlap > 0) sum += c[which] * overlap;
  }
  return sum;
}

function buildHits(blocks: DemoBlock[], hourCost: DemoDataset['hourCost'], now: UnixSeconds): LimitHit[] {
  const hits: LimitHit[] = [];
  for (const b of blocks) {
    // First hour at which the block's cumulative cost crosses 100%.
    for (let t = b.start + HOUR; t <= Math.min(b.end, now) + HOUR; t += HOUR) {
      const at = Math.min(t, b.end, now);
      if (costBetween(hourCost, b.start, at) / b.usdPerPct >= 100) {
        hits.push({ ts: at, kind: 'five_hour', resetsAt: b.end });
        break;
      }
      if (at >= Math.min(b.end, now)) break;
    }
  }
  return hits;
}

function buildLive(plan: SessionPlan, now: UnixSeconds): LiveRequest[] {
  const out: LiveRequest[] = [];
  const firstMinute = Math.floor(now / MINUTE) * MINUTE - 59 * MINUTE;
  for (let t = firstMinute; t <= now; t += MINUTE) {
    const r = rngFor('live', t);
    const n = r.weighted([0, 1, 2, 3, 4], [2, 3, 3, 2, 1]);
    for (let i = 0; i < n; i++) {
      const ts = t + r.int(0, 59);
      if (ts > now) continue;
      const sub = r.chance(0.3);
      const model = sub ? MODELS.haiku : plan.mainModel;
      const u = requestTokens(r, model, sub ? 'subagent' : 'main', 1);
      out.push({
        requestId: `req_demo_${t.toString(36)}_${i}`,
        ts,
        sessionId: plan.meta.sessionId,
        model,
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite5m: u.cacheWrite5m,
        cacheWrite1h: u.cacheWrite1h,
        costUsd: costOf(u, model),
        durationMs: r.int(1800, 42_000),
        ttftMs: r.int(450, 3200),
        speed: 'standard',
        effort: sub ? null : r.pick(['medium', 'high', 'high']),
        querySource: sub ? 'agent:subagent' : 'repl_main_thread',
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export function buildDataset(now: UnixSeconds, tz: string): DemoDataset {
  const today = dayKey(now, tz);
  const plans: SessionPlan[] = [];
  for (let d = DEMO_DAYS - 1; d >= 0; d--) {
    plans.push(...planDay(addDays(today, -d), tz, d).filter((p) => p.meta.firstTs < now - 2 * HOUR || d > 0));
  }
  const live = liveSessionPlan(now);
  plans.push(live);

  const buckets: HourlyBucket[] = [];
  const sessions: SessionMeta[] = [];
  for (const p of plans) {
    if (p.meta.firstTs >= now) continue;
    const bs = sessionBuckets(p, now);
    if (!bs.length) continue;
    buckets.push(...bs);
    sessions.push(finishSessionMeta(p, bs, now));
  }

  const hourCost = new Map<UnixSeconds, { all: number; fable: number }>();
  for (const b of buckets) {
    const c = hourCost.get(b.hour) ?? { all: 0, fable: 0 };
    c.all += b.costUsd;
    if (b.model.includes('fable')) c.fable += b.costUsd;
    hourCost.set(b.hour, c);
  }
  const firstActivity = new Map<UnixSeconds, UnixSeconds>();
  for (const s of sessions) {
    for (let h = Math.floor(s.firstTs / HOUR) * HOUR; h <= s.lastTs; h += HOUR) {
      const first = Math.max(h, s.firstTs);
      const prev = firstActivity.get(h);
      if (prev == null || first < prev) firstActivity.set(h, first);
    }
  }
  const blocks = buildBlocks(hourCost, firstActivity);
  return {
    now,
    tz,
    buckets,
    sessions,
    projects: DEMO_PROJECTS,
    hits: buildHits(blocks, hourCost, now),
    blocks,
    live: buildLive(live, now),
    hourCost,
  };
}
