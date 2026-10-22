import { describe, expect, it } from 'vitest';
import type { TimeseriesSeries } from '@ccu/shared';
import { foldOther, isAllZero, rowTotal, toRows } from '../src/components/charts/series';
import { sortRows } from '../src/components/DataTable';
import { OTHER_KEY } from '../src/palette';

const s = (key: string, points: Array<[number, number]>): TimeseriesSeries => ({ key, label: key.toUpperCase(), points });

describe('chart series', () => {
  it('folds the smallest series into Other, keeping input order', () => {
    const input = Array.from({ length: 10 }, (_, i) =>
      s(`k${i}`, [
        [0, i + 1],
        [3600, 1],
      ]),
    );
    const out = foldOther(input, 8);
    expect(out).toHaveLength(8);
    expect(out.at(-1)!.key).toBe(OTHER_KEY);
    // The 7 largest (k3..k9) survive in their original order.
    expect(out.slice(0, 7).map((x) => x.key)).toEqual(['k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
    expect(out.at(-1)!.points).toEqual([
      [0, 1 + 2 + 3],
      [3600, 3],
    ]);
  });

  it('leaves small sets alone', () => {
    const input = [s('a', [[0, 1]])];
    expect(foldOther(input)).toEqual(input);
  });

  it('pivots into zero-filled rows', () => {
    const rows = toRows([
      s('a', [
        [0, 1],
        [7200, 2],
      ]),
      s('b', [[3600, 5]]),
    ]);
    expect(rows).toEqual([
      { t: 0, a: 1, b: 0 },
      { t: 3600, a: 0, b: 5 },
      { t: 7200, a: 2, b: 0 },
    ]);
    expect(rowTotal(rows[1]!, ['a', 'b'])).toBe(5);
  });

  it('detects all-zero data', () => {
    expect(isAllZero([s('a', [[0, 0]])])).toBe(true);
    expect(isAllZero([s('a', [[0, 0.1]])])).toBe(false);
  });
});

describe('sortRows', () => {
  const rows = [{ v: 2 }, { v: null }, { v: 10 }, { v: 1 }];
  it('sorts numbers both ways with nulls last', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([1, 2, 10, null]);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([10, 2, 1, null]);
  });
  it('sorts strings', () => {
    expect(sortRows([{ n: 'b' }, { n: 'a' }], (r) => r.n, 'asc').map((r) => r.n)).toEqual(['a', 'b']);
  });
});
