import type { DayKey, UnixSeconds } from './types.js';

export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86400;
export const FIVE_HOUR_SECONDS = 5 * HOUR;
export const SEVEN_DAY_SECONDS = 7 * DAY;

export function nowSeconds(): UnixSeconds {
  return Math.floor(Date.now() / 1000);
}

/** UTC hour start. */
export function hourStartUtc(ts: UnixSeconds): UnixSeconds {
  return Math.floor(ts / HOUR) * HOUR;
}

export function minuteStart(ts: UnixSeconds): UnixSeconds {
  return Math.floor(ts / MINUTE) * MINUTE;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  dow: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `ts` in the IANA timezone `tz`. */
export function localParts(ts: UnixSeconds, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ts * 1000))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    dow: WEEKDAYS[parts.weekday!] ?? 0,
  };
}

/** Offset of `tz` from UTC at `ts`, in seconds (e.g. -21600 for MDT). */
export function tzOffsetSeconds(ts: UnixSeconds, tz: string): number {
  const p = localParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - Math.floor(ts);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local calendar day `YYYY-MM-DD` of `ts` in `tz`. */
export function dayKey(ts: UnixSeconds, tz: string): DayKey {
  const p = localParts(ts, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function hourOfDay(ts: UnixSeconds, tz: string): number {
  return localParts(ts, tz).hour;
}

/** 0 = Sunday */
export function dayOfWeek(ts: UnixSeconds, tz: string): number {
  return localParts(ts, tz).dow;
}

/** Converts a local wall-clock time in `tz` to unix seconds (handles DST by re-checking the offset). */
export function localToUnix(year: number, month: number, day: number, hour: number, minute: number, tz: string): UnixSeconds {
  const guess = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  let ts = guess - tzOffsetSeconds(guess, tz);
  const off2 = tzOffsetSeconds(ts, tz);
  ts = guess - off2;
  return ts;
}

function parseDayKey(day: DayKey): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`invalid day key: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Unix seconds of local midnight that starts `day` in `tz`. */
export function dayKeyStart(day: DayKey, tz: string): UnixSeconds {
  const [y, m, d] = parseDayKey(day);
  return localToUnix(y, m, d, 0, 0, tz);
}

/** Unix seconds of local midnight starting the day that contains `ts`. */
export function dayStart(ts: UnixSeconds, tz: string): UnixSeconds {
  return dayKeyStart(dayKey(ts, tz), tz);
}

/** `[start, end)` of local day `day` (23 or 25 hours on DST days). */
export function dayBounds(day: DayKey, tz: string): { start: UnixSeconds; end: UnixSeconds } {
  return { start: dayKeyStart(day, tz), end: dayKeyStart(addDays(day, 1), tz) };
}

/** Calendar arithmetic on day keys (timezone-free). */
export function addDays(day: DayKey, n: number): DayKey {
  const [y, m, d] = parseDayKey(day);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Every day key from the day of `from` to the day of `to` (inclusive), in `tz`. */
export function daysInRange(from: UnixSeconds, to: UnixSeconds, tz: string): DayKey[] {
  const last = dayKey(to, tz);
  const out: DayKey[] = [];
  for (let d = dayKey(from, tz); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Local hour start in `tz` (differs from the UTC hour start only for fractional-hour offsets). */
export function localHourStart(ts: UnixSeconds, tz: string): UnixSeconds {
  const off = tzOffsetSeconds(ts, tz);
  return Math.floor((ts + off) / HOUR) * HOUR - off;
}

/** Bucket start for timeseries: UTC hour for `hour`, local midnight for `day`. */
export function bucketStart(ts: UnixSeconds, bucket: 'hour' | 'day', tz: string): UnixSeconds {
  return bucket === 'hour' ? localHourStart(ts, tz) : dayStart(ts, tz);
}

/** Default read range: the last 7 days ending now. */
export function defaultRange(now: UnixSeconds = nowSeconds(), days = 7): { from: UnixSeconds; to: UnixSeconds } {
  return { from: now - days * DAY, to: now };
}

// ---------------------------------------------------------------------------
// ISO helpers
// ---------------------------------------------------------------------------

/** Parses ISO-8601 (with any fractional seconds) to unix seconds; null if invalid. */
export function isoToUnix(iso: string): UnixSeconds | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function unixToIso(ts: UnixSeconds): string {
  return new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
}

/** Rounds unix seconds to the nearest minute. */
export function roundToMinute(ts: UnixSeconds): UnixSeconds {
  return Math.round(ts / MINUTE) * MINUTE;
}

/** Normalizes a jittery API `resets_at` ISO string to `YYYY-MM-DDTHH:MM:00Z`; null if invalid. */
export function roundIsoToMinute(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return unixToIso(roundToMinute(ms / 1000));
}

// ---------------------------------------------------------------------------
// Limit windows: pace and projection
// ---------------------------------------------------------------------------

/** Window length by key: five_hour = 5h, everything weekly (seven_day*) = 7d. */
export function windowSeconds(key: string): number {
  return key === 'five_hour' || key.startsWith('five_hour') ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS;
}

export function windowStart(resetsAt: UnixSeconds, lengthSeconds: number): UnixSeconds {
  return resetsAt - lengthSeconds;
}

/** 5-hour block start from its reset time. */
export function fiveHourBlockStart(resetsAt: UnixSeconds): UnixSeconds {
  return resetsAt - FIVE_HOUR_SECONDS;
}

export function isInWindow(ts: UnixSeconds, resetsAt: UnixSeconds, lengthSeconds: number): boolean {
  return ts >= resetsAt - lengthSeconds && ts < resetsAt;
}

/** Fraction (0-1) of the window elapsed at `now`. */
export function elapsedFraction(resetsAt: UnixSeconds, lengthSeconds: number, now: UnixSeconds): number {
  const f = (now - (resetsAt - lengthSeconds)) / lengthSeconds;
  return Math.min(1, Math.max(0, f));
}

/** Below this elapsed fraction, pace is too noisy to report. */
export const MIN_PACE_ELAPSED = 0.02;

/**
 * pace = (utilization/100) / elapsedFraction. 1.0 means on track to reach exactly
 * 100% at reset; > 1 runs out early. Null when too little of the window has elapsed.
 */
export function pace(utilization: number, elapsed: number): number | null {
  if (elapsed < MIN_PACE_ELAPSED) return null;
  return utilization / 100 / elapsed;
}

export interface WindowProjection {
  elapsedFraction: number;
  pace: number | null;
  /** Projected utilization at reset (linear), may exceed 100. */
  projectedAtReset: number | null;
  /** When utilization reaches 100% at the current average rate, if that is before reset. */
  projectedFullAt: UnixSeconds | null;
  secondsToReset: number;
}

/** Linear projection from the window start through the current utilization. */
export function projectWindow(utilization: number, resetsAt: UnixSeconds, lengthSeconds: number, now: UnixSeconds): WindowProjection {
  const elapsed = elapsedFraction(resetsAt, lengthSeconds, now);
  const p = pace(utilization, elapsed);
  const secondsToReset = Math.max(0, resetsAt - now);
  let projectedFullAt: UnixSeconds | null = null;
  if (utilization >= 100) {
    projectedFullAt = now;
  } else if (p != null && utilization > 0) {
    const elapsedSec = elapsed * lengthSeconds;
    const ratePerSec = utilization / elapsedSec;
    const at = now + Math.ceil((100 - utilization) / ratePerSec);
    projectedFullAt = at < resetsAt ? at : null;
  }
  return {
    elapsedFraction: elapsed,
    pace: p,
    projectedAtReset: p == null ? null : p * 100,
    projectedFullAt,
    secondsToReset,
  };
}

/** Compact countdown: `45s`, `12m`, `1h12m`, `3d4h`. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < MINUTE) return `${s}s`;
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m`;
  if (s < DAY) {
    const h = Math.floor(s / HOUR);
    const m = Math.floor((s % HOUR) / MINUTE);
    return m ? `${h}h${pad(m)}m` : `${h}h`;
  }
  const d = Math.floor(s / DAY);
  const h = Math.floor((s % DAY) / HOUR);
  return h ? `${d}d${h}h` : `${d}d`;
}
