// Claude Code statusline: stdin JSON + ~/.claude-usage/cache.json -> one ANSI line.
// No network, no @ccu/shared runtime imports (startup time), and it never throws.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CacheFile } from '@ccu/shared';

const WEEK_SEC = 7 * 24 * 3600;
const STALE_SEC = 30 * 60;
const PER_MODEL_MIN_PCT = 50;

export interface StatuslineOptions {
  /** Unix seconds. */
  now: number;
  color: boolean;
}

interface Window {
  pct: number;
  /** Unix seconds, or null if unknown. */
  resetsAt: number | null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Accepts unix seconds, unix ms, or an ISO string. */
export function toUnixSec(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n > 1e12 ? Math.floor(n / 1000) : n;
  const s = str(v);
  if (s) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

// --- formatting -------------------------------------------------------------

const ANSI = { green: '32', yellow: '33', red: '31', dim: '2' } as const;
type Tone = keyof typeof ANSI;

function paint(text: string, tone: Tone, opts: StatuslineOptions): string {
  return opts.color ? `\x1b[${ANSI[tone]}m${text}\x1b[0m` : text;
}

export function toneFor(pct: number): Tone {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'yellow';
  return 'green';
}

export function bar(pct: number, width = 5): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function fmtPct(pct: number): string {
  return `${Math.round(Math.max(0, pct))}%`;
}

/** Compact duration: 45m, 1h12m, 2d3h. */
export function fmtDuration(sec: number): string {
  const mins = Math.max(0, Math.ceil(sec / 60));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export function fmtUsd(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  return `$${usd.toFixed(2)}`;
}

/** usage / fraction of the week elapsed; null when too early in the window to say. */
export function weeklyPace(pct: number, resetsAt: number | null, now: number): number | null {
  if (resetsAt === null) return null;
  const elapsed = WEEK_SEC - (resetsAt - now);
  if (elapsed < 6 * 3600 || elapsed > WEEK_SEC) return null;
  return pct / ((elapsed / WEEK_SEC) * 100);
}

function paceLabel(pace: number | null, opts: StatuslineOptions): string {
  if (pace === null) return '';
  if (pace <= 1.05) return ` ${paint('(pace ok)', 'dim', opts)}`;
  return ` ${paint(`(pace ${pace.toFixed(1)}×)`, pace > 1.15 ? 'red' : 'yellow', opts)}`;
}

// --- data extraction --------------------------------------------------------

function stdinWindow(input: Obj | null, key: string, now: number): Window | null {
  const w = obj(obj(input?.['rate_limits'])?.[key]);
  const pct = num(w?.['used_percentage']);
  if (pct === null) return null;
  const resetsAt = toUnixSec(w?.['resets_at']);
  if (resetsAt !== null && resetsAt <= now) return { pct: 0, resetsAt: null };
  return { pct, resetsAt };
}

interface CacheWindow {
  key: string;
  label: string;
  pct: number;
  resetsAt: number | null;
}

function cacheWindows(cache: Obj | null, now: number): CacheWindow[] {
  const list = obj(cache?.['limits'])?.['windows'];
  if (!Array.isArray(list)) return [];
  const out: CacheWindow[] = [];
  for (const raw of list) {
    const w = obj(raw);
    const key = str(w?.['key']);
    const pct = num(w?.['utilization']);
    if (!key || pct === null) continue;
    const resetsAt = toUnixSec(w?.['resetsAt']);
    // A window whose reset has passed is stale: its usage is now 0.
    if (resetsAt !== null && resetsAt <= now) continue;
    out.push({ key, label: str(w?.['label']) ?? key, pct, resetsAt });
  }
  return out;
}

function fromCache(windows: CacheWindow[], key: string): Window | null {
  const w = windows.find((x) => x.key === key);
  return w ? { pct: w.pct, resetsAt: w.resetsAt } : null;
}

/** `seven_day:opus` -> "Opus"; falls back to the label. */
function perModelName(w: CacheWindow): string {
  const model = w.key.slice(w.key.indexOf(':') + 1) || w.label;
  const m = /\(([^)]+)\)/.exec(w.label);
  if (m?.[1]) return m[1];
  return model.charAt(0).toUpperCase() + model.slice(1).replace(/_/g, ' ');
}

/** `YYYY-MM-DD` of `now` in tz; null if the tz is invalid. */
function dayIn(tz: string, now: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(now * 1000));
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return null;
  }
}

function contextPct(input: Obj | null): number | null {
  const cw = obj(input?.['context_window']);
  const pct = num(cw?.['used_percentage']);
  if (pct !== null) return pct;
  const used = num(cw?.['total_input_tokens']);
  const size = num(cw?.['context_window_size']);
  return used !== null && size ? (used / size) * 100 : null;
}

// --- render -----------------------------------------------------------------

export function renderStatusline(input: unknown, cacheRaw: unknown, opts: StatuslineOptions): string {
  const { now } = opts;
  const inp = obj(input);
  const cache = obj(cacheRaw) as (Obj & Partial<CacheFile>) | null;
  const model = obj(inp?.['model']);
  const parts: string[] = [str(model?.['display_name']) ?? str(model?.['id']) ?? 'Claude'];

  const cWindows = cacheWindows(cache, now);
  const five = stdinWindow(inp, 'five_hour', now) ?? fromCache(cWindows, 'five_hour');
  const week = stdinWindow(inp, 'seven_day', now) ?? fromCache(cWindows, 'seven_day');

  if (five) {
    const reset = five.resetsAt !== null ? ` ${paint(`↻${fmtDuration(five.resetsAt - now)}`, 'dim', opts)}` : '';
    parts.push(`5h ${paint(`${bar(five.pct)} ${fmtPct(five.pct)}`, toneFor(five.pct), opts)}${reset}`);
  }
  if (week) {
    const pace = weeklyPace(week.pct, week.resetsAt, now);
    parts.push(`wk ${paint(fmtPct(week.pct), toneFor(week.pct), opts)}${paceLabel(pace, opts)}`);
  }
  for (const w of cWindows) {
    if (!w.key.startsWith('seven_day:') || w.pct < PER_MODEL_MIN_PCT) continue;
    parts.push(`${perModelName(w)} wk ${paint(fmtPct(w.pct), toneFor(w.pct), opts)}`);
  }

  const today = obj(cache?.['today']);
  const todayCost = num(today?.['costUsd']);
  const cacheTz = str(cache?.['tz']);
  const todayDay = str(today?.['day']);
  const sessionCost = num(obj(inp?.['cost'])?.['total_cost_usd']);
  if (todayCost !== null && todayDay && cacheTz && dayIn(cacheTz, now) === todayDay) {
    parts.push(`today ${fmtUsd(todayCost)}`);
  } else if (sessionCost !== null) {
    parts.push(`sess ${fmtUsd(sessionCost)}`);
  }

  const ctx = contextPct(inp);
  if (ctx !== null) parts.push(`ctx ${paint(fmtPct(ctx), toneFor(ctx), opts)}`);

  if (cache) {
    const updated = toUnixSec(cache['updatedTs']);
    if (updated !== null && now - updated > STALE_SEC) {
      parts.push(paint(`⚠ sync ${fmtDuration(now - updated)} ago`, 'yellow', opts));
    } else {
      const errors = Array.isArray(cache['errors']) ? cache['errors'] : [];
      const recent = errors.map(obj).find((e) => e && updated !== null && (toUnixSec(e['ts']) ?? 0) >= updated - 300);
      const source = recent ? str(recent['source']) : null;
      if (source) parts.push(paint(`⚠ ${source}`, 'yellow', opts));
    }
  }

  return parts.join(paint(' · ', 'dim', opts));
}

/** Parses stdin text; empty or invalid JSON becomes null. */
export function parseStdin(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function ccuHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['CCU_HOME'] || join(homedir(), '.claude-usage');
}

export function readCache(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function useColor(env: NodeJS.ProcessEnv): boolean {
  return !env['NO_COLOR'];
}

/** Full statusline from raw stdin text. Never throws. */
export function statuslineFromText(text: string, env: NodeJS.ProcessEnv = process.env, now = Date.now() / 1000): string {
  let input: unknown = null;
  try {
    input = parseStdin(text);
    const cache = readCache(join(ccuHome(env), 'cache.json'));
    return renderStatusline(input, cache, { now: Math.floor(now), color: useColor(env) });
  } catch {
    const model = obj(obj(input)?.['model']);
    return (typeof model?.['display_name'] === 'string' && model['display_name']) || 'Claude';
  }
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/** `ccu statusline` and the standalone dist/statusline.js both call this. */
export async function statuslineMain(): Promise<void> {
  let line = 'Claude';
  try {
    line = statuslineFromText(await readStdin(1000));
  } catch {
    // keep the minimal line
  }
  process.stdout.write(`${line}\n`);
}

/** True when this module is the process entry (`node dist/statusline.js`). */
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

if (isEntry()) void statuslineMain();
