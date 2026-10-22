import { DAY, DEFAULT_SETTINGS, HOUR, localToUnix, MINUTE, type Settings } from '@ccu/shared';
import { describe, expect, it } from 'vitest';
import {
  asciiHeader,
  budgetAlert,
  dedupe,
  evaluateRules,
  HIT_LOOKBACK,
  hitAlerts,
  isAwake,
  ntfyUrl,
  paceAlerts,
  staleAlert,
  thresholdAlerts,
  UNKNOWN_HIT_GRACE,
  windowLabel,
  type RuleInput,
  type WindowState,
} from '../src/alerts.js';

const TZ = 'America/Denver';
/** 2027-01-15 14:00 local (MST), a waking hour. */
const NOW = localToUnix(2027, 1, 15, 14, 0, TZ);

function settings(over: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    alertThresholds: { fiveHour: [75, 90], weekly: [75, 90] },
    ...over,
  };
}

function win(key: string, utilization: number, resetsIn: number): WindowState {
  return { key, ts: NOW - 60, utilization, resetsAt: NOW + resetsIn };
}

describe('windowLabel', () => {
  it('labels known and per-model keys', () => {
    expect(windowLabel('five_hour')).toBe('5-hour session');
    expect(windowLabel('seven_day')).toBe('Weekly (all models)');
    expect(windowLabel('seven_day:fable')).toBe('Weekly (Fable)');
    expect(windowLabel('seven_day_opus')).toBe('Weekly (Opus)');
    expect(windowLabel('other_thing')).toBe('Other Thing');
  });
});

describe('thresholdAlerts', () => {
  it('stays quiet below every threshold', () => {
    expect(thresholdAlerts([win('five_hour', 74.9, HOUR)], settings(), NOW)).toEqual([]);
  });

  it('fires at exactly the threshold with default priority', () => {
    const [a] = thresholdAlerts([win('five_hour', 75, HOUR)], settings(), NOW);
    expect(a).toMatchObject({ rule: 'threshold', key: `threshold:five_hour:75:${NOW + HOUR}`, covers: [], priority: 'default' });
    expect(a!.windowReset).toBe(NOW + HOUR);
    expect(a!.message).toContain('Resets in 1h');
  });

  it('sends one push for the highest crossed threshold and covers the lower ones', () => {
    const [a, ...rest] = thresholdAlerts([win('seven_day', 93, 3 * DAY)], settings(), NOW);
    expect(rest).toEqual([]);
    expect(a!.key).toBe(`threshold:seven_day:90:${NOW + 3 * DAY}`);
    expect(a!.covers).toEqual([`threshold:seven_day:75:${NOW + 3 * DAY}`]);
    expect(a!.priority).toBe('high');
    expect(a!.title).toBe('Weekly (all models) limit at 93%');
  });

  it('uses weekly thresholds for per-model windows and 5-hour ones for five_hour', () => {
    const s = settings({ alertThresholds: { fiveHour: [50], weekly: [80] } });
    const out = thresholdAlerts([win('five_hour', 60, HOUR), win('seven_day:fable', 60, DAY), win('seven_day:fable2', 81, DAY)], s, NOW);
    expect(out.map((a) => a.key)).toEqual([`threshold:five_hour:50:${NOW + HOUR}`, `threshold:seven_day:fable2:80:${NOW + DAY}`]);
  });

  it('ignores windows that already reset and bogus thresholds', () => {
    const s = settings({ alertThresholds: { fiveHour: [0, -5, 150, Number.NaN], weekly: [] } });
    expect(thresholdAlerts([win('five_hour', 99, HOUR)], s, NOW)).toEqual([]);
    expect(thresholdAlerts([win('five_hour', 99, 0)], settings(), NOW)).toEqual([]);
  });

  it('sorts unsorted thresholds', () => {
    const s = settings({ alertThresholds: { fiveHour: [90, 75], weekly: [] } });
    const [a] = thresholdAlerts([win('five_hour', 95, HOUR)], s, NOW);
    expect(a!.key).toContain(':90:');
    expect(a!.covers[0]).toContain(':75:');
  });
});

describe('paceAlerts', () => {
  // Weekly window that started 2 days ago (5 days left): elapsed = 2/7.
  const resetsIn = 5 * DAY;
  const elapsed = 2 / 7;

  it('fires above 1.15 pace with more than a day left', () => {
    const util = 100 * elapsed * 1.2; // pace 1.2
    const [a] = paceAlerts([win('seven_day', util, resetsIn)], settings(), NOW);
    expect(a).toMatchObject({ rule: 'pace', key: `pace:seven_day:${NOW + resetsIn}`, priority: 'default' });
    expect(a!.title).toBe('Weekly (all models) pace 1.20x');
  });

  it('does not fire at or below 1.15', () => {
    expect(paceAlerts([win('seven_day', 100 * elapsed * 1.15, resetsIn)], settings(), NOW)).toEqual([]);
    expect(paceAlerts([win('seven_day', 100 * elapsed * 1.0, resetsIn)], settings(), NOW)).toEqual([]);
  });

  it('needs more than one day left', () => {
    expect(paceAlerts([win('seven_day', 95, DAY)], settings(), NOW)).toEqual([]);
    expect(paceAlerts([win('seven_day', 95, DAY - 1)], settings(), NOW)).toEqual([]);
    expect(paceAlerts([win('seven_day', 50, DAY + HOUR)], settings(), NOW)).toHaveLength(0); // pace 0.5/0.85 < 1.15
    expect(paceAlerts([win('seven_day', 99, DAY + HOUR)], settings(), NOW)).toHaveLength(1);
  });

  it('skips 5-hour windows, full windows, the setting off, and too-early windows', () => {
    expect(paceAlerts([win('five_hour', 80, HOUR)], settings(), NOW)).toEqual([]);
    expect(paceAlerts([win('seven_day', 100, 3 * DAY)], settings(), NOW)).toEqual([]);
    expect(paceAlerts([win('seven_day', 60, 3 * DAY)], settings({ weeklyPaceAlert: false }), NOW)).toEqual([]);
    // 1% of the window elapsed: pace is too noisy to report.
    expect(paceAlerts([win('seven_day', 5, 7 * DAY - HOUR)], settings(), NOW)).toEqual([]);
  });

  it('covers per-model weekly windows', () => {
    expect(paceAlerts([win('seven_day:fable', 70, 3 * DAY)], settings(), NOW)[0]!.key).toBe(`pace:seven_day:fable:${NOW + 3 * DAY}`);
  });
});

describe('budgetAlert', () => {
  it('is off when the budget is 0 or cost is unknown', () => {
    expect(budgetAlert(500, settings({ dailyBudgetUsd: 0 }), NOW, TZ)).toBeNull();
    expect(budgetAlert(null, settings({ dailyBudgetUsd: 10 }), NOW, TZ)).toBeNull();
  });

  it('fires at cost >= budget, keyed by the local day', () => {
    expect(budgetAlert(9.99, settings({ dailyBudgetUsd: 10 }), NOW, TZ)).toBeNull();
    const a = budgetAlert(10, settings({ dailyBudgetUsd: 10 }), NOW, TZ)!;
    expect(a).toMatchObject({ rule: 'budget', key: 'budget:2027-01-15', priority: 'high' });
    expect(a.windowReset).toBe(localToUnix(2027, 1, 16, 0, 0, TZ));
    expect(a.title).toBe('Daily budget reached: $10.00');
  });

  it('uses the local day, not UTC', () => {
    const lateEvening = localToUnix(2027, 1, 15, 23, 30, TZ); // already Jan 16 in UTC
    expect(budgetAlert(20, settings({ dailyBudgetUsd: 10 }), lateEvening, TZ)!.key).toBe('budget:2027-01-15');
  });
});

describe('staleAlert', () => {
  it('is quiet with no sync history or a fresh sync', () => {
    expect(staleAlert(null, settings(), NOW, TZ)).toBeNull();
    expect(staleAlert(NOW - 60 * MINUTE, settings(), NOW, TZ)).toBeNull();
  });

  it('fires past staleSyncMinutes, keyed by the last sync', () => {
    const last = NOW - 61 * MINUTE;
    expect(staleAlert(last, settings(), NOW, TZ)).toMatchObject({ rule: 'stale', key: `stale:${last}`, windowReset: last });
    expect(staleAlert(NOW - 31 * MINUTE, settings({ staleSyncMinutes: 30 }), NOW, TZ)).not.toBeNull();
  });

  it('respects local quiet hours (23:00-08:00)', () => {
    const at = (h: number, m = 0) => localToUnix(2027, 1, 15, h, m, TZ);
    expect(isAwake(at(7, 59), TZ)).toBe(false);
    expect(isAwake(at(8), TZ)).toBe(true);
    expect(isAwake(at(22, 59), TZ)).toBe(true);
    expect(isAwake(at(23), TZ)).toBe(false);
    expect(isAwake(at(3), TZ)).toBe(false);
    expect(staleAlert(at(3) - 2 * HOUR, settings(), at(3), TZ)).toBeNull();
    expect(staleAlert(at(9) - 2 * HOUR, settings(), at(9), TZ)).not.toBeNull();
  });
});

describe('hitAlerts', () => {
  it('collapses repeats per kind and reset, urgent priority', () => {
    const reset = NOW + 2 * HOUR;
    const out = hitAlerts(
      [
        { ts: NOW - 300, kind: 'five_hour', resetsAt: reset },
        { ts: NOW - 200, kind: 'five_hour', resetsAt: reset },
        { ts: NOW - 100, kind: 'seven_day', resetsAt: NOW + 3 * DAY },
      ],
      NOW,
    );
    expect(out.map((a) => a.key)).toEqual([`hit:five_hour:${reset}`, `hit:seven_day:${NOW + 3 * DAY}`]);
    expect(out[0]).toMatchObject({ priority: 'urgent', title: 'Limit hit: 5-hour session', windowReset: reset });
    expect(out[0]!.message).toContain('Resets in 2h');
  });

  it('keys hits without a reset by their timestamp and labels unknown kinds', () => {
    const ts = NOW - UNKNOWN_HIT_GRACE;
    const [a] = hitAlerts([{ ts, kind: 'unknown', resetsAt: null }], NOW);
    expect(a).toMatchObject({ key: `hit:unknown:${ts}`, title: 'Limit hit: A rate limit (HTTP 429)', windowReset: null });
  });

  it('holds an unknown (OTLP) hit back for the grace period so sync can type it', () => {
    expect(hitAlerts([{ ts: NOW - UNKNOWN_HIT_GRACE + 60, kind: 'unknown', resetsAt: null }], NOW)).toEqual([]);
  });

  it('alerts a 429 seen by both OTLP and sync once', () => {
    const reset = NOW + 2 * HOUR;
    const unknown = { ts: NOW - 20 * 60, kind: 'unknown', resetsAt: null };
    const typed = { ts: NOW - 20 * 60 + 30, kind: 'five_hour', resetsAt: reset };
    // Both rows present: only the typed alert.
    expect(hitAlerts([unknown, typed], NOW).map((a) => a.key)).toEqual([`hit:five_hour:${reset}`]);
    // The unknown alert already went out before sync caught up: the typed one stays quiet,
    // including later hits of the same window.
    const fired = new Set([`hit:unknown:${unknown.ts}`]);
    const later = { ts: NOW - 60, kind: 'five_hour', resetsAt: reset };
    expect(hitAlerts([typed, later], NOW, fired)).toEqual([]);
    // A typed hit far from the fired unknown one still alerts.
    expect(hitAlerts([{ ts: NOW - 60, kind: 'seven_day', resetsAt: NOW + DAY }], NOW, fired)).toHaveLength(1);
  });

  it('collapses a burst of unknown 429s into one alert', () => {
    const burst = [0, 60, 120, 240].map((d) => ({ ts: NOW - 30 * 60 + d, kind: 'unknown', resetsAt: null }));
    expect(hitAlerts(burst, NOW).map((a) => a.key)).toEqual([`hit:unknown:${NOW - 30 * 60}`]);
    expect(hitAlerts(burst, NOW, new Set([`hit:unknown:${NOW - 30 * 60}`]))).toEqual([]);
  });

  it('ignores old hits (e.g. from a backfill)', () => {
    expect(hitAlerts([{ ts: NOW - HIT_LOOKBACK - 1, kind: 'five_hour', resetsAt: null }], NOW)).toEqual([]);
  });
});

describe('evaluateRules + dedupe', () => {
  const base: RuleInput = { now: NOW, tz: TZ, settings: settings({ dailyBudgetUsd: 5 }), windows: [], todayCostUsd: null, lastSyncTs: NOW, hits: [] };

  it('returns nothing when everything is fine', () => {
    expect(evaluateRules({ ...base, windows: [win('five_hour', 10, HOUR)], todayCostUsd: 1 })).toEqual([]);
  });

  it('orders alerts by urgency', () => {
    const out = evaluateRules({
      ...base,
      windows: [win('five_hour', 80, HOUR), win('seven_day', 60, 5 * DAY)],
      todayCostUsd: 6,
      lastSyncTs: NOW - 3 * HOUR,
      hits: [{ ts: NOW - 60, kind: 'five_hour', resetsAt: NOW + HOUR }],
    });
    expect(out.map((a) => a.rule)).toEqual(['hit', 'budget', 'threshold', 'pace', 'stale']);
  });

  it('drops already-fired keys', () => {
    const out = evaluateRules({ ...base, windows: [win('five_hour', 80, HOUR), win('seven_day', 80, 3 * DAY)] });
    const fired = new Set([`threshold:five_hour:75:${NOW + HOUR}`]);
    expect(dedupe(out, fired).map((a) => a.key)).toEqual([`threshold:seven_day:75:${NOW + 3 * DAY}`, `pace:seven_day:${NOW + 3 * DAY}`]);
  });

  it('a new reset produces a fresh key', () => {
    const fired = new Set(evaluateRules({ ...base, windows: [win('five_hour', 80, HOUR)] }).map((a) => a.key));
    const next = evaluateRules({ ...base, windows: [win('five_hour', 80, 5 * HOUR)] });
    expect(dedupe(next, fired)).toHaveLength(1);
  });
});

describe('ntfy helpers', () => {
  it('builds the topic URL, defaulting the server', () => {
    expect(ntfyUrl({})).toBeNull();
    expect(ntfyUrl({ NTFY_TOPIC: '  ' })).toBeNull();
    expect(ntfyUrl({ NTFY_TOPIC: 'abc' })).toBe('https://ntfy.sh/abc');
    expect(ntfyUrl({ NTFY_TOPIC: 'abc', NTFY_SERVER: 'https://push.example/' })).toBe('https://push.example/abc');
  });

  it('keeps headers ASCII', () => {
    expect(asciiHeader('Weekly — 90% ↻')).toBe('Weekly - 90%');
  });
});
