import { formatCountdown, normalizeModel } from '@ccu/shared';

const DASH = '–';

function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Compact number: 950, 12.9K, 1.2M, 3.4B. */
export function fmtCompact(n: number | null | undefined, digits = 1): string {
  if (!finite(n)) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [base, suffix] of units) {
    if (abs >= base * 0.9995) {
      const v = abs / base;
      const d = v >= 100 ? 0 : digits;
      return `${sign}${trimZeros(v.toFixed(d))}${suffix}`;
    }
  }
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Token count, compact: "1.2M tokens" style without the unit word. */
export function fmtTokens(n: number | null | undefined): string {
  return fmtCompact(n);
}

/** Full integer with separators, for tooltips and tables. */
export function fmtInt(n: number | null | undefined): string {
  return finite(n) ? Math.round(n).toLocaleString('en-US') : DASH;
}

/** USD: $38.20, $0.42, $0.0031, $1.2K, $14.5K. */
export function fmtUsd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (!finite(n)) return DASH;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (opts.compact !== false && abs >= 10_000) return `${sign}$${fmtCompact(abs)}`;
  if (abs === 0) return '$0.00';
  if (abs < 0.01) return `${sign}$${abs.toPrecision(2)}`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Percent from a 0-100 value: 42%, 7.5%, 0.4%. */
export function fmtPct(n: number | null | undefined, digits?: number): string {
  if (!finite(n)) return DASH;
  const d = digits ?? (Math.abs(n) >= 10 || n === 0 ? 0 : 1);
  return `${trimZeros(n.toFixed(d))}%`;
}

/** Percent from a 0-1 ratio. */
export function fmtRatio(r: number | null | undefined, digits?: number): string {
  return finite(r) ? fmtPct(r * 100, digits) : DASH;
}

/** Duration from seconds: 45s, 12m, 1h 12m, 3d 4h. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (!finite(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Milliseconds, for request latency: 820ms, 4.2s. */
export function fmtMs(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${trimZeros((ms / 1000).toFixed(1))}s`;
}

/** Compact countdown to a reset time: 1h12m, 3d4h. */
export function fmtCountdown(targetTs: number, now: number): string {
  return formatCountdown(targetTs - now);
}

/** Relative time: "just now", "5m ago", "3h ago", "2d ago", "in 4h". */
export function fmtRelative(ts: number | null | undefined, now: number): string {
  if (!finite(ts)) return 'never';
  const diff = now - ts;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  const span = fmtDuration(abs).split(' ')[0]!;
  return diff >= 0 ? `${span} ago` : `in ${span}`;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });
    dtfCache.set(key, f);
  }
  return f;
}

/** "Oct 22, 14:05" */
export function fmtDateTime(ts: number, tz: string): string {
  return dtf(tz, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts * 1000);
}

/** "Oct 22" */
export function fmtDate(ts: number, tz: string): string {
  return dtf(tz, { month: 'short', day: 'numeric' }).format(ts * 1000);
}

/** "Wed, Oct 22" */
export function fmtWeekdayDate(ts: number, tz: string): string {
  return dtf(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(ts * 1000);
}

/** "14:05" */
export function fmtTime(ts: number, tz: string): string {
  return dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts * 1000);
}

/** Axis tick for a time scale: hours for short spans, dates for long ones. */
export function fmtAxisTime(ts: number, tz: string, spanSeconds: number): string {
  return spanSeconds <= 2 * 86400 ? fmtTime(ts, tz) : fmtDate(ts, tz);
}

/** `YYYY-MM-DD` day key to "Oct 22". */
export function fmtDayKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return dtf('UTC', { month: 'short', day: 'numeric' }).format(Date.UTC(y, m - 1, d));
}

const FAMILY_NAMES: Record<string, string> = {
  fable: 'Fable',
  mythos: 'Mythos',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

/**
 * Human model name: `claude-opus-5-5-20261001` -> "Opus 5.5",
 * `claude-3-5-sonnet-20241022` -> "Sonnet 3.5". Unknown ids pass through.
 */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return 'Unknown';
  const id = normalizeModel(model).id;
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  if (modern && FAMILY_NAMES[modern[1]!]) {
    return `${FAMILY_NAMES[modern[1]!]} ${modern[2]}${modern[3] ? '.' + modern[3] : ''}`;
  }
  const legacy = /^claude-(\d+)(?:-(\d))?-([a-z]+)/.exec(id);
  if (legacy && FAMILY_NAMES[legacy[3]!]) {
    return `${FAMILY_NAMES[legacy[3]!]} ${legacy[1]}${legacy[2] ? '.' + legacy[2] : ''}`;
  }
  return id;
}

/** Model family word ("opus", "fable", ...) or null; drives stable model colors. */
export function modelFamilyWord(model: string): string | null {
  const id = normalizeModel(model).id;
  for (const w of Object.keys(FAMILY_NAMES)) if (id.includes(`-${w}`)) return w;
  return null;
}

const AGENT_LABELS: Record<string, string> = { main: 'Main', subagent: 'Subagent', workflow: 'Workflow' };
export function agentKindLabel(kind: string): string {
  return AGENT_LABELS[kind] ?? kind;
}

const TOKEN_LABELS: Record<string, string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite5m: 'Cache write 5m',
  cacheWrite1h: 'Cache write 1h',
};
export function tokenTypeLabel(type: string): string {
  return TOKEN_LABELS[type] ?? type;
}

/** Signed relative change as a percent of `prev`; null when there is no baseline. */
export function pctChange(curr: number, prev: number | null | undefined): number | null {
  if (!finite(prev) || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}
