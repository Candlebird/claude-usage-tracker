import { describe, expect, it } from 'vitest';
import { OTHER_COLOR, OTHER_KEY, SERIES, assignColors, modelColorMap, seriesColor, statusFor } from '../src/palette';

describe('palette', () => {
  it('never cycles: slots past the 8th are Other', () => {
    expect(seriesColor(0)).toBe(SERIES[0]);
    expect(seriesColor(8)).toBe(OTHER_COLOR);
    expect(seriesColor(-1)).toBe(OTHER_COLOR);
  });

  it('keeps model colors stable when the set is filtered', () => {
    const all = ['claude-fable-1-20260901', 'claude-opus-5-5-20261001', 'claude-sonnet-5-20260801', 'claude-haiku-4-5-20251001'];
    const full = modelColorMap(all);
    const filtered = modelColorMap(all.slice(1, 3));
    for (const m of all.slice(1, 3)) expect(filtered.get(m)).toBe(full.get(m));
    expect(full.get('claude-fable-1-20260901')).toBe(SERIES[0]);
    expect(full.get('claude-opus-5-5-20261001')).toBe(SERIES[1]);
  });

  it('gives older versions of a family a spare slot', () => {
    const m = modelColorMap(['claude-opus-5-5-20261001', 'claude-opus-4-1-20250805']);
    expect(m.get('claude-opus-5-5-20261001')).toBe(SERIES[1]);
    expect(m.get('claude-opus-4-1-20250805')).toBe(SERIES[4]);
  });

  it('assigns in order and paints the Other key gray', () => {
    const m = assignColors(['a', 'b', OTHER_KEY]);
    expect(m.get('a')).toBe(SERIES[0]);
    expect(m.get('b')).toBe(SERIES[1]);
    expect(m.get(OTHER_KEY)).toBe(OTHER_COLOR);
  });

  it('maps utilization to status', () => {
    expect(statusFor(10)).toBe('ok');
    expect(statusFor(70)).toBe('warning');
    expect(statusFor(95)).toBe('serious');
    expect(statusFor(100)).toBe('critical');
    expect(statusFor(80, [85, 95])).toBe('ok');
  });
});
