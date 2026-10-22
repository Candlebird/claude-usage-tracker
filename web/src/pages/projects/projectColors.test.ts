import { describe, expect, it } from 'vitest';
import { OTHER_COLOR, OTHER_KEY, seriesColor } from '../../palette';
import { foldUncolored, projectColorMap } from './projectColors';

const rows = (costs: Record<string, number>) => Object.entries(costs).map(([project, costUsd]) => ({ project, costUsd }));

describe('projectColorMap', () => {
  it('assigns slots by key order, not by cost rank', () => {
    const m = projectColorMap(rows({ 'c:/b': 1, 'c:/a': 50, 'c:/c': 10 }));
    expect(m.get('c:/a')).toBe(seriesColor(0));
    expect(m.get('c:/b')).toBe(seriesColor(1));
    expect(m.get('c:/c')).toBe(seriesColor(2));
  });

  it('keeps a project color when costs reorder', () => {
    const a = projectColorMap(rows({ x: 1, y: 2, z: 3 }));
    const b = projectColorMap(rows({ x: 9, y: 2, z: 0.1 }));
    for (const k of ['x', 'y', 'z']) expect(a.get(k)).toBe(b.get(k));
  });

  it('gives the cheapest projects past the limit the Other color', () => {
    const costs: Record<string, number> = {};
    for (let i = 0; i < 10; i++) costs[`p${i}`] = i + 1;
    const m = projectColorMap(rows(costs), 8);
    const colored = [...m.entries()].filter(([, c]) => c !== OTHER_COLOR).map(([k]) => k);
    expect(colored.sort()).toEqual(['p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    expect(m.get('p0')).toBe(OTHER_COLOR);
    expect(new Set(colored.map((k) => m.get(k))).size).toBe(7);
  });

  it('handles an empty list', () => {
    expect(projectColorMap([]).size).toBe(0);
  });
});

describe('foldUncolored', () => {
  const colors = new Map([
    ['a', seriesColor(0)],
    ['b', OTHER_COLOR],
  ]);

  it('keeps colored series and sums the rest into one Other series', () => {
    const out = foldUncolored(
      [
        { key: 'a', points: [[1, 1], [2, 2]] },
        { key: 'b', points: [[1, 3]] },
        { key: 'unknown', points: [[1, 1], [3, 5]] },
      ],
      colors,
    );
    expect(out.map((s) => s.key)).toEqual(['a', OTHER_KEY]);
    expect(out[1]!.points).toEqual([[1, 4], [3, 5]]);
    expect(out[1]!.label).toBe('Other (2)');
  });

  it('names a single folded project', () => {
    expect(foldUncolored([{ key: 'b', points: [[1, 1]] }], colors)[0]!.label).toBe('Other project');
  });

  it('returns the colored series unchanged when nothing folds', () => {
    const s = [{ key: 'a', points: [[1, 1]] as [number, number][] }];
    expect(foldUncolored(s, colors)).toEqual(s);
  });
});
