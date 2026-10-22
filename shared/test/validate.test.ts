import { describe, expect, it } from 'vitest';
import {
  ARRAY_LIMITS,
  STRING_LIMITS,
  mergeSettings,
  parseCacheFile,
  validateConfig,
  validateDailyLegacyIngest,
  validateLimitsIngest,
  validateSettingsUpdate,
  validateUsageIngest,
  type ValidationResult,
} from '../src/validate.js';
import { DEFAULT_SETTINGS } from '../src/types.js';

// Synthetic fixtures only.
const HOUR = 1_780_000_000 - (1_780_000_000 % 3600);

function bucket(over: Record<string, unknown> = {}) {
  return {
    hour: HOUR,
    project: 'c:/dev/example-project',
    model: 'claude-sonnet-4-6',
    agentKind: 'main',
    sessionId: '00000000-0000-4000-8000-000000000001',
    input: 10,
    output: 20,
    cacheRead: 300,
    cacheWrite5m: 40,
    cacheWrite1h: 0,
    webSearch: 0,
    requests: 2,
    costUsd: 0.0123,
    ...over,
  };
}

function usage(over: Record<string, unknown> = {}) {
  return { device: 'test-device', version: '2.0.0', buckets: [bucket()], ...over };
}

function errorOf<T>(r: ValidationResult<T>): string {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
}

function valueOf<T>(r: ValidationResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

describe('validateUsageIngest', () => {
  it('accepts a minimal payload and drops unknown fields', () => {
    const v = valueOf(validateUsageIngest(usage({ extra: 'x', buckets: [bucket({ junk: 1 })] })));
    expect(v).toEqual({ device: 'test-device', version: '2.0.0', buckets: [bucket()] });
    expect('extra' in v).toBe(false);
  });

  it('defaults webSearch to 0 and allows missing buckets', () => {
    const b = bucket();
    delete (b as Partial<typeof b>).webSearch;
    expect(valueOf(validateUsageIngest(usage({ buckets: [b] }))).buckets[0]!.webSearch).toBe(0);
    expect(valueOf(validateUsageIngest({ device: 'd', version: '1' })).buckets).toEqual([]);
  });

  it('accepts the full payload', () => {
    const v = valueOf(
      validateUsageIngest(
        usage({
          sessions: [
            {
              sessionId: 's1',
              project: 'c:/dev/example-project',
              title: 'Synthetic title',
              gitBranch: 'main',
              firstTs: HOUR,
              lastTs: HOUR + 60,
              models: ['claude-opus-4-7', 'claude-opus-4-7', 'claude-haiku-4-5'],
              agentCount: 2,
              costStateUsd: 1.5,
              linesAdded: 10,
              linesRemoved: 3,
            },
          ],
          projects: [{ project: 'c:/dev/example-project', label: 'example-project', path: 'C:\\dev\\example-project' }],
          limitHits: [{ ts: HOUR, kind: 'five_hour', resetsAt: HOUR + 3600 }, { ts: HOUR }],
          pending: 1234,
          stats: { outputIncomplete: 3, unpricedModels: ['mystery'], errors: ['x'.repeat(1000)] },
        }),
      ),
    );
    expect(v.sessions![0]!.models).toEqual(['claude-opus-4-7', 'claude-haiku-4-5']);
    expect(v.projects![0]!.label).toBe('example-project');
    expect(v.limitHits).toEqual([
      { ts: HOUR, kind: 'five_hour', resetsAt: HOUR + 3600 },
      { ts: HOUR, kind: 'unknown', resetsAt: null },
    ]);
    expect(v.pending).toBe(1234);
    expect(v.stats!.errors![0]!.length).toBe(STRING_LIMITS.error);
  });

  it.each([
    ['non-object body', 'nope', 'body'],
    ['missing device', { version: '1', buckets: [] }, 'device'],
    ['empty device', { device: '  ', version: '1', buckets: [] }, 'device'],
    ['long device', { device: 'x'.repeat(STRING_LIMITS.device + 1), version: '1', buckets: [] }, 'device'],
    ['buckets not array', usage({ buckets: {} }), 'buckets'],
    ['hour not aligned', usage({ buckets: [bucket({ hour: HOUR + 1 })] }), 'buckets[0].hour'],
    ['hour out of range', usage({ buckets: [bucket({ hour: 3600 })] }), 'buckets[0].hour'],
    ['bad agentKind', usage({ buckets: [bucket({ agentKind: 'robot' })] }), 'buckets[0].agentKind'],
    ['negative tokens', usage({ buckets: [bucket({ input: -1 })] }), 'buckets[0].input'],
    ['fractional tokens', usage({ buckets: [bucket({ output: 1.5 })] }), 'buckets[0].output'],
    ['NaN cost', usage({ buckets: [bucket({ costUsd: Number.NaN })] }), 'buckets[0].costUsd'],
    ['string count', usage({ buckets: [bucket({ requests: '2' })] }), 'buckets[0].requests'],
    ['long model', usage({ buckets: [bucket({ model: 'm'.repeat(STRING_LIMITS.model + 1) })] }), 'buckets[0].model'],
    ['session ts order', usage({ sessions: [{ sessionId: 's', project: 'p', firstTs: HOUR + 10, lastTs: HOUR, models: [] }] }), 'sessions[0]'],
    ['bad limit hit ts', usage({ limitHits: [{ ts: 'yesterday' }] }), 'limitHits[0].ts'],
  ])('rejects %s', (_name, body, path) => {
    expect(errorOf(validateUsageIngest(body))).toMatch(new RegExp(`^${path.replace(/[[\].]/g, '\\$&')}:`));
  });

  it('caps array lengths', () => {
    const buckets = Array.from({ length: ARRAY_LIMITS.buckets + 1 }, () => bucket());
    expect(errorOf(validateUsageIngest(usage({ buckets })))).toMatch(/too many items/);
    const ok = Array.from({ length: ARRAY_LIMITS.buckets }, () => bucket());
    expect(validateUsageIngest(usage({ buckets: ok })).ok).toBe(true);
  });

  it('truncates cosmetic optional strings instead of rejecting', () => {
    const v = valueOf(
      validateUsageIngest(usage({ sessions: [{ sessionId: 's', project: 'p', firstTs: HOUR, lastTs: HOUR, models: [], title: 't'.repeat(999) }] })),
    );
    expect(v.sessions![0]!.title!.length).toBe(STRING_LIMITS.title);
  });
});

describe('validateLimitsIngest', () => {
  const window = { key: 'five_hour', label: '5-hour session', utilization: 42.5, resetsAt: '2026-03-04T10:00:00Z', severity: 'normal' };

  it('accepts snapshots', () => {
    const v = valueOf(validateLimitsIngest({ device: 'd', snapshots: [{ ts: HOUR, windows: [window, { key: 'seven_day:fable', utilization: 3, resetsAt: '2026-03-09T00:00:00.000Z', isActive: true }] }] }));
    expect(v.snapshots[0]!.windows[0]).toEqual({ ...window, isActive: null });
    expect(v.snapshots[0]!.windows[1]).toMatchObject({ key: 'seven_day:fable', label: 'seven_day:fable', severity: null, isActive: true });
    expect(v.device).toBe('d');
  });

  it.each([
    ['missing snapshots', {}, 'snapshots'],
    ['bad resetsAt', { snapshots: [{ ts: HOUR, windows: [{ ...window, resetsAt: 'soon' }] }] }, 'snapshots[0].windows[0].resetsAt'],
    ['utilization type', { snapshots: [{ ts: HOUR, windows: [{ ...window, utilization: '50' }] }] }, 'snapshots[0].windows[0].utilization'],
    ['negative utilization', { snapshots: [{ ts: HOUR, windows: [{ ...window, utilization: -1 }] }] }, 'snapshots[0].windows[0].utilization'],
    ['too many windows', { snapshots: [{ ts: HOUR, windows: Array(ARRAY_LIMITS.windowsPerSnapshot + 1).fill(window) }] }, 'snapshots[0].windows'],
  ])('rejects %s', (_n, body, path) => {
    expect(errorOf(validateLimitsIngest(body))).toContain(`${path}:`);
  });
});

describe('validateDailyLegacyIngest', () => {
  it('accepts rows', () => {
    const v = valueOf(validateDailyLegacyIngest({ days: [{ day: '2026-02-28', model: 'claude-opus-4-5', tokens: 123, requests: 4 }] }));
    expect(v.days).toHaveLength(1);
  });

  it.each(['2026-2-28', '2026-13-01', '2026-02-32', '20260228', ''])('rejects day %j', (d) => {
    expect(errorOf(validateDailyLegacyIngest({ days: [{ day: d, model: 'm', tokens: 1, requests: 1 }] }))).toContain('days[0].day');
  });

  it('rejects negative tokens', () => {
    expect(errorOf(validateDailyLegacyIngest({ days: [{ day: '2026-02-28', model: 'm', tokens: -1, requests: 1 }] }))).toContain('days[0].tokens');
  });
});

describe('validateSettingsUpdate', () => {
  it('accepts a partial update and sorts/dedupes thresholds', () => {
    const v = valueOf(validateSettingsUpdate({ dailyBudgetUsd: 25, alertThresholds: { fiveHour: [90, 75, 90], weekly: [80] }, other: true }));
    expect(v).toEqual({ dailyBudgetUsd: 25, alertThresholds: { fiveHour: [75, 90], weekly: [80] } });
  });

  it('accepts an empty update', () => {
    expect(valueOf(validateSettingsUpdate({}))).toEqual({});
  });

  it.each([
    [{ dailyBudgetUsd: -1 }, 'dailyBudgetUsd'],
    [{ alertThresholds: { fiveHour: [75] } }, 'alertThresholds.weekly'],
    [{ alertThresholds: { fiveHour: [150], weekly: [] } }, 'alertThresholds.fiveHour[0]'],
    [{ weeklyPaceAlert: 'yes' }, 'weeklyPaceAlert'],
    [{ staleSyncMinutes: 1 }, 'staleSyncMinutes'],
    [{ staleSyncMinutes: 30.5 }, 'staleSyncMinutes'],
    [{ ntfyEnabled: 1 }, 'ntfyEnabled'],
  ])('rejects %j', (body, path) => {
    expect(errorOf(validateSettingsUpdate(body))).toContain(`${path}:`);
  });

  it('mergeSettings applies the update over current settings', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { dailyBudgetUsd: 10 });
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, dailyBudgetUsd: 10 });
    expect(DEFAULT_SETTINGS.dailyBudgetUsd).toBe(0);
  });
});

describe('validateConfig', () => {
  const cfg = { apiUrl: 'https://usage.example.workers.dev/', writeToken: 'synthetic-write', tz: 'America/Denver', deviceName: 'laptop' };

  it('accepts and normalizes', () => {
    const v = valueOf(validateConfig({ ...cfg, maxRowsPerRun: 500, maxRowsPerDay: 20000, readToken: 'synthetic-read' }));
    expect(v.maxRowsPerDay).toBe(20000);
    expect(v.apiUrl).toBe('https://usage.example.workers.dev');
    expect(v.maxRowsPerRun).toBe(500);
    expect(v.readToken).toBe('synthetic-read');
  });

  it('rejects a non-positive daily row budget', () => {
    expect(errorOf(validateConfig({ ...cfg, maxRowsPerDay: 0 }))).toContain('maxRowsPerDay');
    expect(errorOf(validateConfig({ ...cfg, maxRowsPerDay: 'lots' }))).toContain('maxRowsPerDay');
  });

  it('allows http only for localhost', () => {
    expect(validateConfig({ ...cfg, apiUrl: 'http://127.0.0.1:8787' }).ok).toBe(true);
    expect(errorOf(validateConfig({ ...cfg, apiUrl: 'http://example.com' }))).toContain('apiUrl');
    expect(errorOf(validateConfig({ ...cfg, apiUrl: 'not a url' }))).toContain('apiUrl');
  });

  it('rejects an unknown timezone and missing token', () => {
    expect(errorOf(validateConfig({ ...cfg, tz: 'Nowhere/Land' }))).toContain('tz');
    expect(errorOf(validateConfig({ ...cfg, writeToken: undefined }))).toContain('writeToken');
  });
});

describe('parseCacheFile', () => {
  const good = {
    version: 1,
    updatedTs: HOUR,
    lastSyncTs: null,
    tz: 'UTC',
    limits: { fetchedTs: null, windows: [] },
    today: { day: '2026-03-04', costUsd: 1, tokens: 2, requests: 3 },
    burnRatePerHour: 0.5,
    pending: 0,
    errors: [],
  };

  it('parses a valid file', () => {
    expect(parseCacheFile(JSON.stringify(good))).toEqual(good);
  });

  it('returns null for garbage or the wrong version', () => {
    expect(parseCacheFile('{')).toBeNull();
    expect(parseCacheFile('null')).toBeNull();
    expect(parseCacheFile(JSON.stringify({ ...good, version: 2 }))).toBeNull();
    expect(parseCacheFile(JSON.stringify({ ...good, today: undefined }))).toBeNull();
  });

  it('fills missing optional counters', () => {
    const { errors: _e, pending: _p, ...rest } = good;
    expect(parseCacheFile(JSON.stringify(rest))).toMatchObject({ errors: [], pending: 0 });
  });
});
