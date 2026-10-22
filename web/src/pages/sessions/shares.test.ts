import { describe, expect, it } from 'vitest';
import { OTHER_COLOR, OTHER_KEY } from '../../palette';
import { seriesTotals, toShares } from './shares';

const part = (key: string, value: number) => ({ key, label: key.toUpperCase(), value, color: `c-${key}` });

describe('toShares', () => {
  it('drops zero, negative and non-finite parts and sorts largest first', () => {
    const out = toShares([part('a', 1), part('b', 0), part('c', 3), part('d', -2), part('e', Number.NaN)]);
    expect(out.map((s) => s.key)).toEqual(['c', 'a']);
    expect(out.map((s) => s.share)).toEqual([0.75, 0.25]);
  });

  it('returns nothing when the total is zero', () => {
    expect(toShares([part('a', 0)])).toEqual([]);
    expect(toShares([])).toEqual([]);
  });

  it('folds parts past the limit into Other', () => {
    const out = toShares([part('a', 5), part('b', 4), part('c', 3), part('d', 2), part('e', 1)], 3);
    expect(out.map((s) => s.key)).toEqual(['a', 'b', OTHER_KEY]);
    expect(out[2]).toMatchObject({ value: 6, color: OTHER_COLOR, label: 'Other (3)' });
    expect(out.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
  });

  it('does not fold when exactly at the limit', () => {
    expect(toShares([part('a', 1), part('b', 1)], 2).map((s) => s.key)).toEqual(['a', 'b']);
  });
});

describe('seriesTotals', () => {
  it('sums each series in input order', () => {
    expect(
      seriesTotals([
        { key: 'x', label: 'X', points: [[1, 2], [2, 3]] },
        { key: 'y', points: [] },
      ]),
    ).toEqual([
      { key: 'x', label: 'X', total: 5 },
      { key: 'y', total: 0 },
    ]);
  });
});
