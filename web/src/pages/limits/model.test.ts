import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FiveHourBlock, type LimitHistoryPoint, type LimitWindowStatus, type Settings } from '@ccu/shared';
import {
  buildPaceModel,
  hitKindLabel,
  hitWindowKey,
  hitsForWindow,
  hitRows,
  historyStats,
  median,
  orderWindowKeys,
  paceVerdict,
  resetMarkers,
  summarizeBlocks,
  thresholdsFor,
  windowColors,
} from './model';

const H = 3600;
const D = 86_400;
const pt = (ts: number, utilization: number, resetsAt: number): LimitHistoryPoint => ({ ts, utilization, resetsAt, severity: null });

function block(start: number, peak: number, cost: number, extra: Partial<FiveHourBlock> = {}): FiveHourBlock {
  return {
    start,
    end: start + 5 * H,
    peakUtilization: peak,
    costUsd: cost,
    tokens: 1000,
    requests: 10,
    costPerPercent: peak > 0 ? cost / peak : null,
    active: false,
    ...extra,
  };
}

describe('thresholdsFor', () => {
  it('uses the five-hour pair for session windows and weekly for the rest', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, alertThresholds: { fiveHour: [60, 80], weekly: [70, 95] } };
    expect(thresholdsFor('five_hour', s)).toEqual([60, 80]);
    expect(thresholdsFor('seven_day', s)).toEqual([70, 95]);
    expect(thresholdsFor('seven_day:fable', s)).toEqual([70, 95]);
  });
  it('falls back to defaults without settings', () => {
    expect(thresholdsFor('five_hour', undefined)).toEqual([...DEFAULT_SETTINGS.alertThresholds.fiveHour]);
  });
});

describe('orderWindowKeys / windowColors', () => {
  it('orders five-hour, weekly, then per-model weeklies, deduped', () => {
    expect(orderWindowKeys(['seven_day:zeta', 'seven_day', 'seven_day:alpha', 'five_hour', 'seven_day'])).toEqual([
      'five_hour',
      'seven_day',
      'seven_day:alpha',
      'seven_day:zeta',
    ]);
  });
  it('assigns the same color to a key regardless of input order', () => {
    const a = windowColors(['seven_day', 'five_hour']);
    const b = windowColors(['five_hour', 'seven_day']);
    expect(a.get('seven_day')).toBe(b.get('seven_day'));
    expect(a.get('five_hour')).not.toBe(a.get('seven_day'));
  });
});

describe('hitKindLabel', () => {
  it('prefers a window label, then known names, then derives one', () => {
    expect(hitKindLabel('seven_day:x', [{ key: 'seven_day:x', label: 'Custom' }])).toBe('Custom');
    expect(hitKindLabel('five_hour')).toBe('5-hour session');
    expect(hitKindLabel('seven_day_opus')).toBe('Weekly (Opus)');
    expect(hitKindLabel('unknown')).toBe('Unknown limit');
  });
  it('matches a raw transcript kind to its per-model window label', () => {
    expect(hitKindLabel('seven_day_opus', [{ key: 'seven_day:opus', label: 'Weekly (Opus 4)' }])).toBe('Weekly (Opus 4)');
  });
});

describe('hitWindowKey / hitsForWindow', () => {
  it('maps seven_day_<model> to seven_day:<model> and leaves other kinds alone', () => {
    expect(hitWindowKey('seven_day_opus')).toBe('seven_day:opus');
    expect(hitWindowKey('seven_day')).toBe('seven_day');
    expect(hitWindowKey('five_hour')).toBe('five_hour');
    expect(hitWindowKey('seven_day:opus')).toBe('seven_day:opus');
  });
  it('assigns a seven_day_opus hit to the seven_day:opus window only', () => {
    const hits = [
      { ts: 1, kind: 'seven_day_opus', resetsAt: null },
      { ts: 2, kind: 'seven_day', resetsAt: null },
    ];
    expect(hitsForWindow(hits, 'seven_day:opus').map((h) => h.ts)).toEqual([1]);
    expect(hitsForWindow(hits, 'seven_day').map((h) => h.ts)).toEqual([2]);
  });
});

describe('resetMarkers', () => {
  it('marks a reset once its time has passed by the next sample', () => {
    const r1 = 10 * H;
    const r2 = 15 * H;
    const pts = [pt(8 * H, 40, r1), pt(9 * H, 60, r1), pt(11 * H, 5, r2), pt(12 * H, 10, r2)];
    expect(resetMarkers(pts)).toEqual([r1]);
  });
  it('ignores idle points whose rolling reset moves forward', () => {
    const pts = [pt(1 * H, 0, 6 * H), pt(2 * H, 0, 7 * H), pt(3 * H, 0, 8 * H)];
    expect(resetMarkers(pts)).toEqual([]);
  });
  it('ignores an idle (0%) window that lapses', () => {
    const pts = [pt(1 * H, 0, 2 * H), pt(3 * H, 0, 8 * H)];
    expect(resetMarkers(pts)).toEqual([]);
  });
});

describe('historyStats', () => {
  it('summarizes peak, latest, share above warning and resets', () => {
    const pts = [pt(1 * H, 20, 2 * H), pt(2 * H, 80, 2 * H), pt(3 * H, 90, 9 * H), pt(4 * H, 50, 9 * H)];
    expect(historyStats(pts, 75)).toEqual({ peak: 90, peakTs: 3 * H, latest: 50, shareAboveWarning: 0.5, resets: 1 });
  });
  it('handles no points', () => {
    expect(historyStats([], 75)).toEqual({ peak: null, peakTs: null, latest: null, shareAboveWarning: null, resets: 0 });
  });
});

describe('median / summarizeBlocks', () => {
  it('computes medians for odd and even counts', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('estimates capacity from blocks with a meaningful peak only', () => {
    const blocks = [
      block(0, 50, 25), // 0.5 per 1%
      block(5 * H, 100, 60), // 0.6
      block(10 * H, 20, 8), // 0.4
      block(15 * H, 2, 10), // excluded: peak below the floor
      block(20 * H, 30, 9, { active: true }), // 0.3
    ];
    const s = summarizeBlocks(blocks);
    expect(s.count).toBe(5);
    expect(s.completed).toBe(4);
    expect(s.maxedOut).toBe(1);
    expect(s.avgPeak).toBeCloseTo(40.4);
    expect(s.sampleSize).toBe(4);
    expect(s.medianCostPerPercent).toBeCloseTo(0.45);
    expect(s.capacityUsd).toBeCloseTo(45);
  });
  it('returns nulls for no blocks', () => {
    const s = summarizeBlocks([]);
    expect(s).toMatchObject({ count: 0, avgPeak: null, medianCostPerPercent: null, capacityUsd: null, sampleSize: 0 });
  });
});

describe('buildPaceModel', () => {
  const resetsAt = 100 * D;
  const start = resetsAt - 7 * D;
  const now = start + 3.5 * D;
  const w: LimitWindowStatus = {
    key: 'seven_day',
    label: 'Weekly',
    utilization: 60,
    resetsAt,
    severity: null,
    snapshotTs: now - 600,
    windowSeconds: 7 * D,
    elapsedFraction: 0.5,
    pace: 1.2,
    projectedFullAt: start + (100 / 60) * 3.5 * D,
    projectedAtReset: 120,
  };
  const history = [
    pt(start - D, 90, start), // previous window: excluded
    pt(start + D, 10, resetsAt),
    pt(start + 2 * D, 30, resetsAt),
    pt(start + 3 * D, 50, resetsAt),
  ];

  it('builds start, history, now and reset rows', () => {
    const m = buildPaceModel(w, history, now);
    expect(m.start).toBe(start);
    expect(m.rows.map((r) => r.t)).toEqual([start, start + D, start + 2 * D, start + 3 * D, now, resetsAt]);
    expect(m.rows[0]).toEqual({ t: start, actual: 0, even: 0 });
    const nowRow = m.rows[4]!;
    expect(nowRow.actual).toBe(60);
    expect(nowRow.projected).toBe(60);
    expect(nowRow.even).toBeCloseTo(50);
    expect(m.rows[5]).toEqual({ t: resetsAt, even: 100, projected: 120 });
  });

  it('derives the daily allowance and the last-24h rate', () => {
    const m = buildPaceModel(w, history, now);
    expect(m.allowancePerDay).toBeCloseTo(40 / 3.5);
    // The latest point at or before now-24h is start+2D (30%).
    expect(m.last24h).toBe(30);
    expect(m.recentRunsOut).toBe(true);
  });

  it('omits the projection when pace is unknown', () => {
    const m = buildPaceModel({ ...w, pace: null, projectedAtReset: null, projectedFullAt: null, utilization: 1 }, [], start + H);
    expect(m.rows.some((r) => r.projected != null)).toBe(false);
    expect(m.rows[m.rows.length - 1]).toEqual({ t: resetsAt, even: 100 });
    expect(m.last24h).toBe(1);
  });

  it('has no allowance after reset', () => {
    expect(buildPaceModel(w, history, resetsAt + 10).allowancePerDay).toBeNull();
  });
});

describe('paceVerdict', () => {
  it('maps pace to a tone and text', () => {
    expect(paceVerdict(null)).toEqual({ tone: 'ok', text: 'Too early to tell' });
    expect(paceVerdict(0.8).tone).toBe('ok');
    expect(paceVerdict(1.05).tone).toBe('ahead');
    expect(paceVerdict(1.3).tone).toBe('over');
  });
});

describe('hitRows', () => {
  it('labels hits and computes lockout', () => {
    const rows = hitRows(
      [
        { ts: 1000, kind: 'five_hour', resetsAt: 4600 },
        { ts: 2000, kind: 'seven_day' },
      ],
      [],
    );
    expect(rows[0]).toMatchObject({ id: '1000:five_hour', label: '5-hour session', lockout: 3600 });
    expect(rows[1]!.lockout).toBeNull();
  });
});
