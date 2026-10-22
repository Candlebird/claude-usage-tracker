import { describe, expect, it } from 'vitest';
import {
  FIVE_HOUR_SECONDS,
  SEVEN_DAY_SECONDS,
  addDays,
  bucketStart,
  dayBounds,
  dayKey,
  dayKeyStart,
  dayOfWeek,
  dayStart,
  daysInRange,
  defaultRange,
  elapsedFraction,
  fiveHourBlockStart,
  formatCountdown,
  hourOfDay,
  hourStartUtc,
  isInWindow,
  isValidTimeZone,
  isoToUnix,
  localHourStart,
  pace,
  projectWindow,
  roundIsoToMinute,
  tzOffsetSeconds,
  unixToIso,
  windowSeconds,
} from '../src/time.js';

const t = (iso: string) => Date.parse(iso) / 1000;
const DENVER = 'America/Denver';

describe('timezone bucketing', () => {
  it('hourStartUtc floors to the hour', () => {
    expect(hourStartUtc(t('2026-03-04T05:59:59Z'))).toBe(t('2026-03-04T05:00:00Z'));
    expect(hourStartUtc(t('2026-03-04T05:00:00Z'))).toBe(t('2026-03-04T05:00:00Z'));
  });

  it('tzOffsetSeconds handles DST', () => {
    expect(tzOffsetSeconds(t('2026-01-15T12:00:00Z'), DENVER)).toBe(-7 * 3600);
    expect(tzOffsetSeconds(t('2026-07-15T12:00:00Z'), DENVER)).toBe(-6 * 3600);
    expect(tzOffsetSeconds(t('2026-07-15T12:00:00Z'), 'UTC')).toBe(0);
    expect(tzOffsetSeconds(t('2026-07-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3600);
  });

  it('dayKey uses the local calendar day', () => {
    // 03:00 UTC on the 5th is the evening of the 4th in Denver.
    expect(dayKey(t('2026-03-05T03:00:00Z'), DENVER)).toBe('2026-03-04');
    expect(dayKey(t('2026-03-05T03:00:00Z'), 'UTC')).toBe('2026-03-05');
    expect(dayKey(t('2026-03-04T20:00:00Z'), 'Asia/Tokyo')).toBe('2026-03-05');
  });

  it('hourOfDay and dayOfWeek are local', () => {
    const ts = t('2026-03-05T03:30:00Z'); // Wed 20:30 in Denver (MST)
    expect(hourOfDay(ts, DENVER)).toBe(20);
    expect(dayOfWeek(ts, DENVER)).toBe(3);
    expect(hourOfDay(ts, 'UTC')).toBe(3);
    expect(dayOfWeek(ts, 'UTC')).toBe(4);
    expect(hourOfDay(t('2026-03-05T00:00:00Z'), 'UTC')).toBe(0);
  });

  it('dayStart finds local midnight', () => {
    expect(dayStart(t('2026-03-05T03:00:00Z'), DENVER)).toBe(t('2026-03-04T07:00:00Z'));
    expect(dayStart(t('2026-07-05T12:00:00Z'), DENVER)).toBe(t('2026-07-05T06:00:00Z'));
    expect(dayKeyStart('2026-07-05', 'UTC')).toBe(t('2026-07-05T00:00:00Z'));
  });

  it('dayBounds is 23h on spring-forward and 25h on fall-back days', () => {
    const spring = dayBounds('2026-03-08', DENVER);
    expect(spring.start).toBe(t('2026-03-08T07:00:00Z'));
    expect(spring.end - spring.start).toBe(23 * 3600);
    const fall = dayBounds('2026-11-01', DENVER);
    expect(fall.start).toBe(t('2026-11-01T06:00:00Z'));
    expect(fall.end - fall.start).toBe(25 * 3600);
    const normal = dayBounds('2026-06-01', DENVER);
    expect(normal.end - normal.start).toBe(24 * 3600);
  });

  it('dayStart is stable on DST transition days', () => {
    expect(dayStart(t('2026-03-08T20:00:00Z'), DENVER)).toBe(t('2026-03-08T07:00:00Z'));
    expect(dayStart(t('2026-11-01T20:00:00Z'), DENVER)).toBe(t('2026-11-01T06:00:00Z'));
  });

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-01-10', 0)).toBe('2026-01-10');
    expect(() => addDays('2026-1-10', 1)).toThrow();
  });

  it('daysInRange is inclusive and local', () => {
    expect(daysInRange(t('2026-03-01T12:00:00Z'), t('2026-03-03T12:00:00Z'), 'UTC')).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(daysInRange(t('2026-03-05T03:00:00Z'), t('2026-03-05T05:00:00Z'), DENVER)).toEqual(['2026-03-04']);
  });

  it('localHourStart respects half-hour offsets', () => {
    const ts = t('2026-07-15T12:10:00Z'); // 17:40 IST
    expect(localHourStart(ts, 'Asia/Kolkata')).toBe(t('2026-07-15T11:30:00Z'));
    expect(localHourStart(ts, DENVER)).toBe(t('2026-07-15T12:00:00Z'));
  });

  it('bucketStart picks hour or day', () => {
    const ts = t('2026-07-15T12:10:00Z');
    expect(bucketStart(ts, 'hour', DENVER)).toBe(t('2026-07-15T12:00:00Z'));
    expect(bucketStart(ts, 'day', DENVER)).toBe(t('2026-07-15T06:00:00Z'));
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone(DENVER)).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('defaultRange is the last 7 days', () => {
    expect(defaultRange(2_000_000_000)).toEqual({ from: 2_000_000_000 - 7 * 86400, to: 2_000_000_000 });
  });
});

describe('ISO helpers', () => {
  it('isoToUnix parses fractional seconds and rejects garbage', () => {
    expect(isoToUnix('2026-03-04T05:06:07.891234+00:00')).toBe(t('2026-03-04T05:06:07Z'));
    expect(isoToUnix('not a date')).toBeNull();
  });

  it('roundIsoToMinute removes API jitter', () => {
    expect(roundIsoToMinute('2026-03-04T05:59:59.612+00:00')).toBe('2026-03-04T06:00:00Z');
    expect(roundIsoToMinute('2026-03-04T06:00:00.401Z')).toBe('2026-03-04T06:00:00Z');
    expect(roundIsoToMinute('2026-03-04T06:00:29Z')).toBe('2026-03-04T06:00:00Z');
    expect(roundIsoToMinute('nope')).toBeNull();
  });

  it('unixToIso drops zero milliseconds', () => {
    expect(unixToIso(t('2026-03-04T06:00:00Z'))).toBe('2026-03-04T06:00:00Z');
  });
});

describe('limit windows', () => {
  const reset = t('2026-03-04T10:00:00Z');

  it('windowSeconds by key', () => {
    expect(windowSeconds('five_hour')).toBe(FIVE_HOUR_SECONDS);
    expect(windowSeconds('seven_day')).toBe(SEVEN_DAY_SECONDS);
    expect(windowSeconds('seven_day:fable')).toBe(SEVEN_DAY_SECONDS);
    expect(windowSeconds('seven_day_opus')).toBe(SEVEN_DAY_SECONDS);
  });

  it('fiveHourBlockStart and isInWindow', () => {
    expect(fiveHourBlockStart(reset)).toBe(t('2026-03-04T05:00:00Z'));
    expect(isInWindow(t('2026-03-04T05:00:00Z'), reset, FIVE_HOUR_SECONDS)).toBe(true);
    expect(isInWindow(reset, reset, FIVE_HOUR_SECONDS)).toBe(false);
    expect(isInWindow(t('2026-03-04T04:59:59Z'), reset, FIVE_HOUR_SECONDS)).toBe(false);
  });

  it('elapsedFraction is clamped to [0, 1]', () => {
    expect(elapsedFraction(reset, FIVE_HOUR_SECONDS, t('2026-03-04T07:30:00Z'))).toBeCloseTo(0.5, 10);
    expect(elapsedFraction(reset, FIVE_HOUR_SECONDS, t('2026-03-04T01:00:00Z'))).toBe(0);
    expect(elapsedFraction(reset, FIVE_HOUR_SECONDS, t('2026-03-04T11:00:00Z'))).toBe(1);
  });

  it('pace = utilization / elapsed fraction', () => {
    expect(pace(50, 0.5)).toBeCloseTo(1, 10);
    expect(pace(60, 0.5)).toBeCloseTo(1.2, 10);
    expect(pace(20, 0.8)).toBeCloseTo(0.25, 10);
    expect(pace(10, 0.01)).toBeNull();
    expect(pace(0, 0.5)).toBe(0);
  });

  it('projectWindow projects linearly to 100%', () => {
    // 40% used after 2h of 5h: rate 20%/h -> 100% at +3h = reset; projected 100% at reset
    const now = t('2026-03-04T07:00:00Z');
    const p = projectWindow(40, reset, FIVE_HOUR_SECONDS, now);
    expect(p.elapsedFraction).toBeCloseTo(0.4, 10);
    expect(p.pace).toBeCloseTo(1, 10);
    expect(p.projectedAtReset).toBeCloseTo(100, 8);
    expect(p.projectedFullAt).toBeNull(); // reaches 100 exactly at reset, not before
    expect(p.secondsToReset).toBe(3 * 3600);

    // 60% after 2h: 30%/h -> 100% in 80 min
    const fast = projectWindow(60, reset, FIVE_HOUR_SECONDS, now);
    expect(fast.pace).toBeCloseTo(1.5, 10);
    expect(fast.projectedAtReset).toBeCloseTo(150, 8);
    expect(fast.projectedFullAt).toBe(now + 80 * 60);
  });

  it('projectWindow edge cases', () => {
    const now = t('2026-03-04T07:00:00Z');
    expect(projectWindow(100, reset, FIVE_HOUR_SECONDS, now).projectedFullAt).toBe(now);
    expect(projectWindow(0, reset, FIVE_HOUR_SECONDS, now)).toMatchObject({ pace: 0, projectedFullAt: null, projectedAtReset: 0 });
    // too early for a pace
    expect(projectWindow(5, reset, FIVE_HOUR_SECONDS, t('2026-03-04T05:01:00Z'))).toMatchObject({ pace: null, projectedAtReset: null, projectedFullAt: null });
  });

  it('weekly pace above the 1.15 alert line', () => {
    const weeklyReset = t('2026-03-10T00:00:00Z');
    const now = weeklyReset - 4 * 86400; // 3 of 7 days elapsed
    const p = projectWindow(55, weeklyReset, SEVEN_DAY_SECONDS, now);
    expect(p.pace!).toBeGreaterThan(1.15);
    expect(p.projectedFullAt).not.toBeNull();
    expect(p.projectedFullAt!).toBeLessThan(weeklyReset);
  });
});

describe('formatCountdown', () => {
  it.each([
    [-5, '0s'],
    [45, '45s'],
    [12 * 60 + 5, '12m'],
    [3600, '1h'],
    [3600 + 12 * 60, '1h12m'],
    [3600 + 5 * 60, '1h05m'],
    [86400, '1d'],
    [3 * 86400 + 4 * 3600 + 59, '3d4h'],
  ])('%d -> %s', (s, out) => {
    expect(formatCountdown(s)).toBe(out);
  });
});
