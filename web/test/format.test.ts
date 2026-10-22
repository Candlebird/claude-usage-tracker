import { describe, expect, it } from 'vitest';
import { fmtCompact, fmtDuration, fmtMs, fmtPct, fmtRatio, fmtRelative, fmtUsd, modelLabel, pctChange } from '../src/format';

describe('format', () => {
  it('compacts numbers', () => {
    expect(fmtCompact(950)).toBe('950');
    expect(fmtCompact(12_900)).toBe('12.9K');
    expect(fmtCompact(1_000_000)).toBe('1M');
    expect(fmtCompact(-2_500)).toBe('-2.5K');
    expect(fmtCompact(null)).toBe('–');
  });

  it('formats USD', () => {
    expect(fmtUsd(38.2)).toBe('$38.20');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.0031)).toBe('$0.0031');
    expect(fmtUsd(14_500)).toBe('$14.5K');
    expect(fmtUsd(14_500, { compact: false })).toBe('$14,500.00');
    expect(fmtUsd(Number.NaN)).toBe('–');
  });

  it('formats percents and ratios', () => {
    expect(fmtPct(42)).toBe('42%');
    expect(fmtPct(7.5)).toBe('7.5%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtRatio(0.913)).toBe('91%');
  });

  it('formats durations', () => {
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(720)).toBe('12m');
    expect(fmtDuration(4320)).toBe('1h 12m');
    expect(fmtDuration(3 * 86400 + 4 * 3600)).toBe('3d 4h');
    expect(fmtMs(820)).toBe('820ms');
    expect(fmtMs(4200)).toBe('4.2s');
  });

  it('formats relative times', () => {
    expect(fmtRelative(1000, 1010)).toBe('just now');
    expect(fmtRelative(1000, 1300)).toBe('5m ago');
    expect(fmtRelative(1000 + 4 * 3600, 1000)).toBe('in 4h');
    expect(fmtRelative(null, 0)).toBe('never');
  });

  it('labels models', () => {
    expect(modelLabel('claude-opus-5-5-20261001')).toBe('Opus 5.5');
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelLabel('mystery-model')).toBe('mystery-model');
    expect(modelLabel(null)).toBe('Unknown');
  });

  it('computes percent change', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(1, 0)).toBeNull();
    expect(pctChange(1, null)).toBeNull();
  });
});
