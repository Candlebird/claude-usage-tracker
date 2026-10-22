#!/usr/bin/env node
// `ccu`: sync, backfill, import-stats-cache, status, install, uninstall, statusline.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_ROUTES,
  DEFAULT_MAX_ROWS_PER_RUN,
  nowSeconds,
  unixToIso,
  validateUsageIngest,
  type Config,
  type UnixSeconds,
} from '@ccu/shared';
import {
  buildBuckets,
  burnRatePerHour,
  computeToday,
  markPlanUploaded,
  outputIncompleteCount,
  planUpload,
  unpricedModels,
} from './aggregate.js';
import { buildCacheFile, readCacheFile, writeCacheFile } from './cache.js';
import { localDefaults, readConfig } from './config.js';
import { acquireLock } from './lock.js';
import { resolvePaths, type Paths } from './paths.js';
import type { ProjectResolver } from './projects.js';
import { chunkRows, earliestTranscriptDay, readStatsCache, rowsBefore } from './statsCacheImport.js';
import { emptyState, loadState, pruneState, saveState, type SyncState } from './state.js';
import { scanTranscripts } from './transcripts.js';
import { chunkPlan, dropInvalidRows, joinUrl, planRowCount, postJson, toIngest, uploadPlan, type FetchLike } from './upload.js';
import { pollLimits, readLimitsUploadState, shouldUploadLimits, snapshotSignature, type ParsedUsage } from './usageApi.js';

export const VERSION = readVersion();

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '2.0.0';
  } catch {
    return '2.0.0';
  }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface CliFlags {
  dryRun: boolean;
  verbose: boolean;
  home: string | null;
  claudeDir: string | null;
  days: number | null;
  maxRows: number | null;
}

export class UsageError extends Error {}

export function parseFlags(args: string[]): CliFlags {
  const f: CliFlags = { dryRun: false, verbose: false, home: null, claudeDir: null, days: null, maxRows: null };
  const value = (i: number, name: string): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value`);
    return v;
  };
  const posInt = (v: string, name: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const [name, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const take = () => (inline !== undefined ? inline : value(i++, name));
    switch (name) {
      case '--dry-run':
        f.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        f.verbose = true;
        break;
      case '--home':
        f.home = resolve(take());
        break;
      case '--claude-dir':
        f.claudeDir = resolve(take());
        break;
      case '--days':
        f.days = posInt(take(), '--days');
        break;
      case '--max-rows':
        f.maxRows = posInt(take(), '--max-rows');
        break;
      default:
        throw new UsageError(`unknown option ${a}`);
    }
  }
  return f;
}

// ---------------------------------------------------------------------------
// Shared run context
// ---------------------------------------------------------------------------

export interface CliDeps {
  log: (line: string) => void;
  err: (line: string) => void;
  now: () => UnixSeconds;
  /** Used for the Worker; tests inject a fake. */
  fetch?: FetchLike;
  /** Used for the usage API only; tests inject a fake. */
  usageFetch?: FetchLike;
  env: NodeJS.ProcessEnv;
  resolveProject?: ProjectResolver;
  sleep?: (ms: number) => Promise<void>;
}

export const realDeps = (): CliDeps => ({
  log: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  now: nowSeconds,
  env: process.env,
});

interface Ctx {
  flags: CliFlags;
  deps: CliDeps;
  paths: Paths;
  config: Config | null;
  tz: string;
  device: string;
}

/** Resolves paths and config. Without --dry-run a valid config is required. */
function context(flags: CliFlags, deps: CliDeps, requireConfig: boolean): Ctx | number {
  const home = flags.home ?? (deps.env['CCU_HOME'] || join(homedir(), '.claude-usage'));
  const probe = resolvePaths({ usageDir: home });
  const r = readConfig(probe.configFile);
  let config: Config | null = null;
  if (r.kind === 'ok') config = r.config;
  else if (requireConfig) {
    deps.err(
      r.kind === 'missing'
        ? `ccu: no config at ${r.path}. Run \`ccu install\` first (or add --dry-run).`
        : `ccu: invalid config ${r.path}: ${r.error}. Fix it or re-run \`ccu install\`.`,
    );
    return 2;
  } else if (r.kind === 'invalid') deps.err(`ccu: ignoring invalid config ${r.path}: ${r.error}`);
  const local = localDefaults(config);
  const paths = resolvePaths({ usageDir: home, claudeDir: flags.claudeDir ?? local.claudeDir ?? null });
  return { flags, deps, paths, config, tz: local.tz, device: local.deviceName };
}

const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

// ---------------------------------------------------------------------------
// sync / backfill
// ---------------------------------------------------------------------------

interface LimitsUploadFile {
  lastUploadTs: UnixSeconds;
  signature: string;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export async function runSync(args: string[], deps: CliDeps = realDeps(), mode: 'sync' | 'backfill' = 'sync'): Promise<number> {
  const flags = parseFlags(args);
  const ctx = context(flags, deps, !flags.dryRun);
  if (typeof ctx === 'number') return ctx;
  const { paths, config, tz, device } = ctx;
  const say = (l: string) => deps.log(l);
  const verbose = (l: string) => flags.verbose && deps.log(l);
  const now = deps.now();

  const lock = acquireLock(paths.lockFile);
  if (!lock) {
    verbose('ccu: another sync is running; exiting.');
    return 0;
  }
  const errors: { source: string; message: string }[] = [];
  try {
    const state: SyncState = loadState(paths.stateFile);
    const scanOpts = deps.resolveProject ? { now, resolveProject: deps.resolveProject } : { now };
    try {
      const scan = scanTranscripts(paths.projectsDir, state, scanOpts);
      const s = scan.stats;
      verbose(
        `transcripts: ${s.filesSeen} files (${s.filesRead} read, ${s.filesUnchanged} unchanged, ${s.filesReset} reset, ${s.filesRemoved} removed), ` +
          `${fmtInt(s.bytesRead)} bytes, ${fmtInt(s.linesParsed)} lines, ${s.parseErrors} parse errors, ${s.syntheticLines} synthetic, ${s.durationMs} ms`,
      );
      verbose(`requests: ${fmtInt(scan.newRequests)} new, ${fmtInt(scan.improvedRequests)} improved, ${fmtInt(s.duplicateLines)} duplicate lines; ${scan.limitHits.length} new limit hits`);
      if (s.parseErrors) errors.push({ source: 'transcripts', message: `${s.parseErrors} unparseable transcript lines skipped` });
    } catch (e) {
      errors.push({ source: 'transcripts', message: `scan failed: ${(e as Error).message}` });
    }
    // The scan is synchronous and can be long on a backfill; keep the lock visibly alive.
    lock.refresh();
    pruneState(state, now);
    if (!flags.dryRun) saveState(paths.stateFile, state);

    // Limits (read-only; the token never leaves usageApi.ts).
    const poll = await pollLimits(paths.credentialsFile, now, deps.usageFetch ? { fetch: deps.usageFetch, userAgent: `ccu-sync/${VERSION}` } : { userAgent: `ccu-sync/${VERSION}` });
    let parsed: ParsedUsage | null = null;
    if (poll.ok) {
      parsed = poll.parsed;
      for (const w of parsed.snapshot.windows) verbose(`limit ${w.key}: ${w.utilization.toFixed(1)}% (resets ${w.resetsAt})`);
    } else {
      errors.push({ source: 'usageApi', message: poll.error });
      verbose(`limits: ${poll.error}`);
    }

    const maxRows = flags.maxRows ?? config?.maxRowsPerRun ?? DEFAULT_MAX_ROWS_PER_RUN;
    const sinceTs = mode === 'backfill' && flags.days != null ? now - flags.days * 86400 : null;
    const buckets = buildBuckets(state);
    const plan = planUpload(state, { maxRows, sinceTs, buckets });
    const stats = {
      outputIncomplete: outputIncompleteCount(state),
      unpricedModels: unpricedModels(state).slice(0, 100),
    };
    verbose(`state: ${fmtInt(Object.keys(state.reqs).length)} requests, ${fmtInt(buckets.size)} buckets, ${Object.keys(state.sessions).length} sessions, ${Object.keys(state.projects).length} projects`);
    if (stats.unpricedModels.length) verbose(`unpriced models: ${stats.unpricedModels.join(', ')}`);

    let syncedTs: UnixSeconds | null = null;
    let pendingAfter = plan.pending + plan.rows;
    const filtered = dropInvalidRows(plan, { device, version: VERSION });
    if (filtered.rejected.length) {
      errors.push({ source: 'validation', message: `${filtered.rejected.length} row(s) failed local validation and were skipped: ${filtered.rejected[0]}` });
    }
    const sendPlan = { ...plan, ...filtered.plan };
    const chunks = chunkPlan(sendPlan);
    if (flags.dryRun) {
      const invalid = chunks
        .map((c, i) => ({ i, v: validateUsageIngest(toIngest(c, { device, version: VERSION, pending: 0, stats })) }))
        .filter((x) => !x.v.ok);
      say(
        `dry run: would upload ${fmtInt(plan.rows)} rows (${fmtInt(plan.buckets.length)} buckets, ${plan.sessions.length} sessions, ${plan.projects.length} projects, ` +
          `${plan.limitHits.length} limit hits) in ${chunks.length} request(s); ${fmtInt(plan.pending)} rows left for later runs` +
          (plan.outsideWindow ? `, ${fmtInt(plan.outsideWindow)} buckets outside --days` : ''),
      );
      for (const x of invalid.slice(0, 3)) say(`dry run: chunk ${x.i + 1} would be rejected: ${(x.v as { error: string }).error}`);
      if (parsed) say(`dry run: would ${shouldUploadLimits(readLimitsUploadState(join(paths.usageDir, 'limits.json')), parsed.snapshot, now) ? '' : 'not '}upload a limits snapshot (${parsed.snapshot.windows.length} windows)`);
    } else if (config) {
      const invalid = chunks.map((c) => validateUsageIngest(toIngest(c, { device, version: VERSION, pending: 0, stats }))).find((v) => !v.ok);
      if (invalid && !invalid.ok) {
        errors.push({ source: 'upload', message: `payload failed local validation, not sent: ${invalid.error}` });
      } else {
        const out = await uploadPlan(sendPlan, {
          apiUrl: config.apiUrl,
          writeToken: config.writeToken,
          device,
          version: VERSION,
          pendingAfterPlan: plan.pending,
          stats: errors.length ? { ...stats, errors: errors.map((e) => e.message).slice(0, 50) } : stats,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          onChunkAcked: (chunk) => {
            markPlanUploaded(state, chunk);
            saveState(paths.stateFile, state);
            lock.refresh();
          },
        });
        pendingAfter = out.rowsUnsent + plan.pending + filtered.rejected.length;
        if (out.error) errors.push({ source: 'upload', message: out.error });
        else syncedTs = now;
        verbose(`upload: ${fmtInt(out.rowsSent)} rows in ${out.chunksSent} request(s)${out.error ? `; stopped: ${out.error}` : ''}`);
      }
      if (parsed) await uploadLimits(ctx, parsed, now, errors);
    }

    const today = computeToday(state, tz, now);
    const cache = buildCacheFile({
      now,
      tz,
      prev: readCacheFile(paths.cacheFile),
      limits: parsed,
      syncedTs,
      today,
      burnRatePerHour: burnRatePerHour(state, now),
      pending: pendingAfter,
      errors,
    });
    writeCacheFile(paths.cacheFile, cache);
    say(
      `${flags.dryRun ? 'dry run' : 'sync'}: today ${fmtUsd(today.costUsd)} (${fmtInt(today.tokens)} tokens, ${fmtInt(today.requests)} requests), ` +
        `burn ${fmtUsd(cache.burnRatePerHour)}/h, ${fmtInt(pendingAfter)} rows pending, ${errors.length} error(s); cache written to ${paths.cacheFile}`,
    );
    for (const e of errors) verbose(`error [${e.source}]: ${e.message}`);
    return errors.some((e) => e.source === 'upload') ? 1 : 0;
  } finally {
    lock.release();
  }
}

async function uploadLimits(ctx: Ctx, parsed: ParsedUsage, now: UnixSeconds, errors: { source: string; message: string }[]): Promise<void> {
  const file = join(ctx.paths.usageDir, 'limits.json');
  if (!ctx.config || !shouldUploadLimits(readLimitsUploadState(file), parsed.snapshot, now)) return;
  const r = await postJson(
    joinUrl(ctx.config.apiUrl, API_ROUTES.ingestLimits),
    ctx.config.writeToken,
    { snapshots: [parsed.snapshot], device: ctx.device },
    { ...(ctx.deps.fetch ? { fetch: ctx.deps.fetch } : {}), ...(ctx.deps.sleep ? { sleep: ctx.deps.sleep } : {}) },
  );
  if (!r.ok) {
    errors.push({ source: 'limitsUpload', message: r.error });
    return;
  }
  const rec: LimitsUploadFile = { lastUploadTs: now, signature: snapshotSignature(parsed.snapshot) };
  writeJsonAtomic(file, rec);
}

// ---------------------------------------------------------------------------
// import-stats-cache
// ---------------------------------------------------------------------------

export async function runImportStatsCache(args: string[], deps: CliDeps = realDeps()): Promise<number> {
  const flags = parseFlags(args);
  const ctx = context(flags, deps, !flags.dryRun);
  if (typeof ctx === 'number') return ctx;
  const read = readStatsCache(ctx.paths.statsCacheFile);
  if (!read.ok) {
    deps.err(`ccu: ${read.error}`);
    return 1;
  }
  const state = loadState(ctx.paths.stateFile);
  const firstDay = earliestTranscriptDay(state, ctx.tz);
  const rows = rowsBefore(read.rows, firstDay);
  const days = new Set(rows.map((r) => r.day));
  deps.log(
    `stats-cache: ${read.rows.length} day/model rows, ${rows.length} before the first transcript day (${firstDay ?? 'none synced yet'}) covering ${days.size} days` +
      (firstDay ? '' : '. Run `ccu sync` first so overlapping days are not double counted.'),
  );
  if (flags.dryRun || !rows.length) return 0;
  if (!firstDay) return 1;
  const url = joinUrl(ctx.config!.apiUrl, API_ROUTES.ingestDailyLegacy);
  for (const chunk of chunkRows(rows, 1000)) {
    const r = await postJson(url, ctx.config!.writeToken, { days: chunk }, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    if (!r.ok) {
      deps.err(`ccu: ${r.error}`);
      return 1;
    }
  }
  deps.log(`stats-cache: imported ${rows.length} rows.`);
  return 0;
}

// ---------------------------------------------------------------------------
// status (local only, no network)
// ---------------------------------------------------------------------------

export function runStatus(args: string[], deps: CliDeps = realDeps()): number {
  const flags = parseFlags(args);
  const ctx = context(flags, deps, false);
  if (typeof ctx === 'number') return ctx;
  const now = deps.now();
  const log = deps.log;
  log(`config: ${ctx.config ? `${ctx.paths.configFile} (device ${ctx.device}, tz ${ctx.tz})` : `none at ${ctx.paths.configFile}`}`);
  let state: SyncState;
  try {
    state = loadState(ctx.paths.stateFile);
  } catch {
    state = emptyState();
  }
  const plan = planUpload(state, { maxRows: 0 });
  log(`synced state: ${Object.keys(state.files).length} transcript files, ${fmtInt(Object.keys(state.reqs).length)} requests, last scan ${state.lastScanTs ? unixToIso(state.lastScanTs) : 'never'}`);
  log(`pending upload: ${fmtInt(plan.pending)} rows`);
  const cache = readCacheFile(ctx.paths.cacheFile);
  if (!cache) {
    log('cache: none yet (run `ccu sync`).');
    return 0;
  }
  log(`last successful upload: ${cache.lastSyncTs ? `${unixToIso(cache.lastSyncTs)} (${Math.round((now - cache.lastSyncTs) / 60)} min ago)` : 'never'}`);
  log(`today (${cache.today.day}): ${fmtUsd(cache.today.costUsd)}, ${fmtInt(cache.today.tokens)} tokens, ${fmtInt(cache.today.requests)} requests; burn ${fmtUsd(cache.burnRatePerHour)}/h`);
  if (cache.limits.windows.length) {
    log(`limits (fetched ${cache.limits.fetchedTs ? unixToIso(cache.limits.fetchedTs) : 'never'}):`);
    for (const w of cache.limits.windows) log(`  ${w.label}: ${w.utilization.toFixed(1)}%, resets ${unixToIso(w.resetsAt)}`);
  } else log('limits: none cached');
  if (cache.errors.length) {
    log('recent errors:');
    for (const e of cache.errors.slice(0, 10)) log(`  ${unixToIso(e.ts)} [${e.source}] ${e.message}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const HELP = `ccu ${VERSION}: Claude Usage Tracker sync

  ccu sync [--dry-run] [--verbose]            parse transcripts, poll limits, upload, write cache
  ccu backfill [--days N] [--dry-run]         like sync, limited to the last N days
  ccu import-stats-cache [--dry-run]          one-time import of stats-cache.json days before transcripts
  ccu status                                  local summary (no network)
  ccu install | uninstall [--dry-run] ...     interactive setup / removal
  ccu statusline                              Claude Code statusline (reads JSON on stdin)

  common options: --home <dir> (default $CCU_HOME or ~/.claude-usage), --claude-dir <dir>, --max-rows N`;

export async function main(argv: string[], deps: CliDeps = realDeps()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'sync':
        return await runSync(rest, deps, 'sync');
      case 'backfill':
        return await runSync(rest, deps, 'backfill');
      case 'import-stats-cache':
        return await runImportStatsCache(rest, deps);
      case 'status':
        return runStatus(rest, deps);
      case 'install': {
        const { runInstall } = await import('./install.js');
        return await runInstall(rest);
      }
      case 'uninstall': {
        const { runUninstall } = await import('./install.js');
        return await runUninstall(rest);
      }
      case 'statusline': {
        const { statuslineMain } = await import('./statusline.js');
        await statuslineMain();
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        deps.log(HELP);
        return cmd === undefined ? 1 : 0;
      case '--version':
      case 'version':
        deps.log(VERSION);
        return 0;
      default:
        deps.err(`ccu: unknown command "${cmd}"\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(`ccu: ${e.message}`);
      return 1;
    }
    deps.err(`ccu: ${(e as Error).message}`);
    return 1;
  }
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  try {
    return norm(fileURLToPath(import.meta.url)) === norm(argv1);
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
