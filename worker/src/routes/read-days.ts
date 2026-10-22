// Local-day bucketing without calling Intl per row: compute each local midnight
// once, then binary-search hour buckets into days.
import { addDays, DAY, dayKey, dayKeyStart, daysInRange, HOUR, localParts, type DayKey, type UnixSeconds } from '@ccu/shared';

/** UTC hour buckets are assigned to the local day containing their midpoint. */
export const HOUR_MID = HOUR / 2;

export class DayIndex {
  readonly days: DayKey[];
  /** starts[i] = local midnight of days[i]; starts[days.length] = end of the last day. */
  readonly starts: UnixSeconds[];

  constructor(
    from: UnixSeconds,
    to: UnixSeconds,
    readonly tz: string,
  ) {
    this.days = daysInRange(from, to, tz);
    this.starts = this.days.map((d) => dayKeyStart(d, tz));
    const last = this.days[this.days.length - 1]!;
    this.starts.push(dayKeyStart(addDays(last, 1), tz));
  }

  get start(): UnixSeconds {
    return this.starts[0]!;
  }

  get end(): UnixSeconds {
    return this.starts[this.starts.length - 1]!;
  }

  /** Day index of a timestamp, or -1 when outside the indexed days. */
  indexOf(ts: UnixSeconds): number {
    const s = this.starts;
    if (ts < s[0]! || ts >= s[s.length - 1]!) return -1;
    let lo = 0;
    let hi = s.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid]! <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Day index of a UTC hour bucket (by its midpoint). */
  indexOfHour(hour: UnixSeconds): number {
    return this.indexOf(hour + HOUR_MID);
  }

  /** Local hour of day of `ts` inside day `i` (exact on DST days too). */
  localHour(ts: UnixSeconds, i: number): number {
    const start = this.starts[i]!;
    if (this.starts[i + 1]! - start === DAY) return Math.min(23, Math.floor((ts - start) / HOUR));
    return localParts(ts, this.tz).hour;
  }

  /** Day of week of day `i`, 0 = Sunday (calendar arithmetic, no tz needed). */
  dow(i: number): number {
    const [y, m, d] = this.days[i]!.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  }
}

/** Local midnight `n` days before the local day of `now` (n = 0 is today). */
export function localDayStartBack(now: UnixSeconds, n: number, tz: string): UnixSeconds {
  return dayKeyStart(addDays(dayKey(now, tz), -n), tz);
}
