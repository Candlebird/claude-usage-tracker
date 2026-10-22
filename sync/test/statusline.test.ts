import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CacheFile } from '@ccu/shared';
import {
  bar,
  fmtDuration,
  parseStdin,
  renderStatusline,
  statuslineFromText,
  toUnixSec,
  weeklyPace,
} from '../src/statusline.js';

const NOW = 1792700000; // 2026-10-22T20:13:20Z
const plain = { now: NOW, color: false };
const DAY = 86400;

function stdin(extra: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: 'C:/work/demo' },
    cost: { total_cost_usd: 1.234 },
    context_window: { used_percentage: 61.2 },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: NOW + 3600 + 12 * 60 },
      // 3 days into the week at 18% -> pace 0.42
      seven_day: { used_percentage: 18, resets_at: NOW + 4 * DAY },
    },
    ...extra,
  };
}

function cache(over: Partial<CacheFile> = {}): CacheFile {
  return {
    version: 1,
    updatedTs: NOW - 120,
    lastSyncTs: NOW - 120,
    tz: 'UTC',
    limits: {
      fetchedTs: NOW - 120,
      windows: [
        { key: 'five_hour', label: '5-hour session', utilization: 30, resetsAt: NOW + 7200, severity: null },
        { key: 'seven_day', label: 'Weekly (all models)', utilization: 25, resetsAt: NOW + 4 * DAY, severity: null },
        { key: 'seven_day:opus', label: 'Weekly (Opus)', utilization: 63, resetsAt: NOW + 4 * DAY, severity: null },
        { key: 'seven_day:sonnet', label: 'Weekly (Sonnet)', utilization: 12, resetsAt: NOW + 4 * DAY, severity: null },
      ],
    },
    today: { day: '2026-10-22', costUsd: 38.2, tokens: 1_200_000, requests: 300 },
    burnRatePerHour: 4.5,
    pending: 0,
    errors: [],
    ...over,
  };
}

describe('renderStatusline', () => {
  it('renders the full line, preferring stdin rate_limits', () => {
    expect(renderStatusline(stdin(), cache(), plain)).toBe(
      'Opus 5.5 · 5h ▰▰▱▱▱ 42% ↻1h12m · wk 18% (pace ok) · Opus wk 63% · today $38.20 · ctx 61%',
    );
  });

  it('falls back to cache limits when stdin has none', () => {
    const input = stdin();
    delete (input as Record<string, unknown>)['rate_limits'];
    expect(renderStatusline(input, cache(), plain)).toBe(
      'Opus 5.5 · 5h ▰▰▱▱▱ 30% ↻2h00m · wk 25% (pace ok) · Opus wk 63% · today $38.20 · ctx 61%',
    );
  });

  it('accepts ISO resetsAt in the cache', () => {
    const c = cache();
    c.limits.windows = [
      { key: 'five_hour', label: '5h', utilization: 10, resetsAt: new Date((NOW + 45 * 60) * 1000).toISOString() as never, severity: null },
    ];
    expect(renderStatusline({ model: { display_name: 'Sonnet' } }, c, plain)).toBe(
      'Sonnet · 5h ▰▱▱▱▱ 10% ↻45m · today $38.20',
    );
  });

  it('shows session cost and no limits without a cache', () => {
    const input = stdin();
    delete (input as Record<string, unknown>)['rate_limits'];
    expect(renderStatusline(input, null, plain)).toBe('Opus 5.5 · sess $1.23 · ctx 61%');
  });

  it('degrades to the model name on empty input', () => {
    expect(renderStatusline(null, null, plain)).toBe('Claude');
    expect(renderStatusline('garbage', 42, plain)).toBe('Claude');
  });

  it('treats a passed stdin reset as 0% and drops expired cache windows', () => {
    const input = stdin({
      rate_limits: { five_hour: { used_percentage: 99, resets_at: NOW - 10 } },
    });
    const c = cache();
    c.limits.windows = [{ key: 'seven_day', label: 'wk', utilization: 80, resetsAt: NOW - 1, severity: null }];
    expect(renderStatusline(input, c, plain)).toBe('Opus 5.5 · 5h ▱▱▱▱▱ 0% · today $38.20 · ctx 61%');
  });

  it('hides today when the cache day is not today', () => {
    expect(renderStatusline(stdin(), cache({ today: { day: '2026-10-21', costUsd: 9, tokens: 1, requests: 1 } }), plain)).toBe(
      'Opus 5.5 · 5h ▰▰▱▱▱ 42% ↻1h12m · wk 18% (pace ok) · Opus wk 63% · sess $1.23 · ctx 61%',
    );
  });

  it('marks a stale sync and recent errors', () => {
    expect(renderStatusline(stdin({ rate_limits: {} }), cache({ updatedTs: NOW - 2 * 3600 - 300 }), plain)).toBe(
      'Opus 5.5 · 5h ▰▰▱▱▱ 30% ↻2h00m · wk 25% (pace ok) · Opus wk 63% · today $38.20 · ctx 61% · ⚠ sync 2h05m ago',
    );
    const withErr = cache({ errors: [{ ts: NOW - 100, source: 'usageApi', message: 'expired' }] });
    expect(renderStatusline(stdin({ rate_limits: {} }), withErr, plain)).toBe(
      'Opus 5.5 · 5h ▰▰▱▱▱ 30% ↻2h00m · wk 25% (pace ok) · Opus wk 63% · today $38.20 · ctx 61% · ⚠ usageApi',
    );
  });

  it('labels a hot weekly pace', () => {
    // 1 day into the week at 30% -> pace 2.1x
    const input = stdin({ rate_limits: { seven_day: { used_percentage: 30, resets_at: NOW + 6 * DAY } } });
    expect(renderStatusline(input, null, plain)).toBe('Opus 5.5 · wk 30% (pace 2.1×) · sess $1.23 · ctx 61%');
  });

  it('colors by threshold', () => {
    const input = stdin({
      rate_limits: {
        five_hour: { used_percentage: 92, resets_at: NOW + 600 },
        seven_day: { used_percentage: 75, resets_at: NOW + 4 * DAY },
      },
    });
    const line = renderStatusline(input, null, { now: NOW, color: true });
    expect(line).toContain('\x1b[31m▰▰▰▰▰ 92%\x1b[0m');
    expect(line).toContain('wk \x1b[33m75%\x1b[0m');
    expect(line).toContain('ctx \x1b[32m61%\x1b[0m');
    expect(line.replace(/\x1b/g, '^')).toBe(
      'Opus 5.5^[2m · ^[0m5h ^[31m▰▰▰▰▰ 92%^[0m ^[2m↻10m^[0m^[2m · ^[0mwk ^[33m75%^[0m ^[31m(pace 1.8×)^[0m^[2m · ^[0msess $1.23^[2m · ^[0mctx ^[32m61%^[0m',
    );
  });
});

describe('helpers', () => {
  it('formats durations', () => {
    expect(fmtDuration(59)).toBe('1m');
    expect(fmtDuration(3600 + 12 * 60)).toBe('1h12m');
    expect(fmtDuration(2 * DAY + 3 * 3600)).toBe('2d3h');
  });

  it('draws bars', () => {
    expect(bar(0)).toBe('▱▱▱▱▱');
    expect(bar(42)).toBe('▰▰▱▱▱');
    expect(bar(150)).toBe('▰▰▰▰▰');
  });

  it('computes weekly pace', () => {
    expect(weeklyPace(50, NOW + 3.5 * DAY, NOW)).toBeCloseTo(1);
    expect(weeklyPace(5, NOW + 7 * DAY - 3600, NOW)).toBeNull();
    expect(weeklyPace(5, null, NOW)).toBeNull();
  });

  it('parses times and stdin', () => {
    expect(toUnixSec('2026-10-22T20:13:20Z')).toBe(NOW);
    expect(toUnixSec(NOW * 1000)).toBe(NOW);
    expect(toUnixSec('nope')).toBeNull();
    expect(parseStdin('')).toBeNull();
    expect(parseStdin('{bad')).toBeNull();
    expect(parseStdin('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('statuslineFromText', () => {
  it('reads the cache from CCU_HOME and survives junk stdin', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccu-sl-'));
    writeFileSync(join(home, 'cache.json'), JSON.stringify(cache()));
    const env = { CCU_HOME: home, NO_COLOR: '1' };
    expect(statuslineFromText('not json', env, NOW)).toBe('Claude · 5h ▰▰▱▱▱ 30% ↻2h00m · wk 25% (pace ok) · Opus wk 63% · today $38.20');
    expect(statuslineFromText('', { CCU_HOME: join(home, 'missing'), NO_COLOR: '1' }, NOW)).toBe('Claude');
  });

  it('tolerates a corrupt cache file', () => {
    const home = mkdtempSync(join(tmpdir(), 'ccu-sl-'));
    writeFileSync(join(home, 'cache.json'), '{"limits": {"windows": [null, 5, {"key": 1}]}, "today": "x"');
    expect(statuslineFromText(JSON.stringify(stdin()), { CCU_HOME: home, NO_COLOR: '1' }, NOW)).toBe(
      'Opus 5.5 · 5h ▰▰▱▱▱ 42% ↻1h12m · wk 18% (pace ok) · sess $1.23 · ctx 61%',
    );
    writeFileSync(join(home, 'cache.json'), '{"limits": {"windows": [null, 5, {"key": 1}]}, "today": "x"}');
    expect(statuslineFromText('{}', { CCU_HOME: home, NO_COLOR: '1' }, NOW)).toBe('Claude');
  });
});
