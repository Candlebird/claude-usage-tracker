import { describe, expect, it } from 'vitest';
import { DAY } from '@ccu/shared';
import { bucketFor, dateInputToUnix, isRangePreset, resolveRange, unixToDateInput } from '../src/state/range';

const NOW = 1_790_000_123;

describe('range', () => {
  it('resolves presets snapped to the minute', () => {
    const r = resolveRange({ preset: '7d', custom: null }, NOW);
    expect(r.to % 60).toBe(0);
    expect(r.to - r.from).toBe(7 * DAY);
    expect(NOW - r.to).toBeLessThan(60);
  });

  it('uses a valid custom range, clamped to now', () => {
    const r = resolveRange({ preset: 'custom', custom: { from: NOW - 2 * DAY, to: NOW + DAY } }, NOW);
    expect(r).toEqual({ from: NOW - 2 * DAY, to: NOW });
  });

  it('falls back to 7d for an invalid custom range', () => {
    const r = resolveRange({ preset: 'custom', custom: { from: NOW, to: NOW - 10 } }, NOW);
    expect(r.to - r.from).toBe(7 * DAY);
  });

  it('picks hourly buckets up to 3 days', () => {
    expect(bucketFor({ from: 0, to: DAY })).toBe('hour');
    expect(bucketFor({ from: 0, to: 3 * DAY })).toBe('hour');
    expect(bucketFor({ from: 0, to: 7 * DAY })).toBe('day');
  });

  it('validates presets and round-trips date inputs', () => {
    expect(isRangePreset('30d')).toBe(true);
    expect(isRangePreset('custom')).toBe(true);
    expect(isRangePreset('1y')).toBe(false);
    const ts = dateInputToUnix('2026-03-14')!;
    expect(unixToDateInput(ts)).toBe('2026-03-14');
    expect(dateInputToUnix('2026-03-14', true)! - ts).toBeGreaterThanOrEqual(23 * 3600);
    expect(dateInputToUnix('nope')).toBeNull();
  });
});
