import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCacheFile, validateUsageIngest } from '@ccu/shared';
import { describe, expect, it } from 'vitest';
import { parseFlags, runStatus, runSync, UsageError, type CliDeps } from '../src/cli.js';
import { loadState } from '../src/state.js';
import { copyFixtures, fakeResolver } from './helpers.js';

const NOW = Math.floor(Date.parse('2026-03-01T12:00:00Z') / 1000);
const TOKEN = 'synthetic-token-value';

function deps(extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: CliDeps = {
    log: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => NOW,
    env: {},
    resolveProject: fakeResolver(),
    sleep: async () => {},
    usageFetch: async () =>
      Response.json({
        five_hour: { utilization: 30, resets_at: '2026-03-01T15:00:00Z' },
        seven_day: { utilization: 50, resets_at: '2026-03-05T09:00:00Z' },
      }),
    ...extra,
  };
  return { d, out, err };
}

function setup(withConfig: boolean) {
  const projects = copyFixtures();
  const claudeDir = dirname(projects);
  writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
  const home = mkdtempSync(join(tmpdir(), 'ccu-home-'));
  if (withConfig) {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ apiUrl: 'https://api.example.invalid', writeToken: 'synthetic-write', tz: 'UTC', deviceName: 'test-pc' }),
    );
  }
  return { home, claudeDir, args: ['--home', home, '--claude-dir', claudeDir] };
}

describe('parseFlags', () => {
  it('parses flags in both forms', () => {
    const f = parseFlags(['--dry-run', '-v', '--days=7', '--max-rows', '100']);
    expect(f).toMatchObject({ dryRun: true, verbose: true, days: 7, maxRows: 100 });
  });
  it('rejects unknown flags and bad numbers', () => {
    expect(() => parseFlags(['--nope'])).toThrow(UsageError);
    expect(() => parseFlags(['--days', 'x'])).toThrow(UsageError);
    expect(() => parseFlags(['--home'])).toThrow(UsageError);
  });
});

describe('runSync', () => {
  it('requires a config unless dry run', async () => {
    const { args } = setup(false);
    const { d, err } = deps();
    expect(await runSync(args, d)).toBe(2);
    expect(err.join('\n')).toContain('ccu install');
  });

  it('dry run writes cache.json, never state, and never posts', async () => {
    const { home, args } = setup(false);
    let posted = 0;
    const { d, out } = deps({ fetch: async () => (posted++, Response.json({ ok: true })) });
    expect(await runSync([...args, '--dry-run', '--verbose'], d)).toBe(0);
    expect(posted).toBe(0);
    expect(existsSync(join(home, 'state.json'))).toBe(false);
    const cache = parseCacheFile(readFileSync(join(home, 'cache.json'), 'utf8'));
    expect(cache?.limits.windows.map((w) => w.utilization)).toEqual([30, 50]);
    const text = out.join('\n');
    expect(text).toContain('would upload');
    expect(text).not.toContain(TOKEN);
  });

  it('uploads valid chunks, persists state and marks rows uploaded', async () => {
    const { home, args } = setup(true);
    const bodies: { url: string; body: unknown }[] = [];
    const { d, out, err } = deps({
      fetch: async (url, init) => {
        bodies.push({ url, body: JSON.parse(init.body as string) });
        return Response.json({ ok: true, accepted: {} });
      },
    });
    expect(await runSync(args, d)).toBe(0);
    const usage = bodies.filter((b) => b.url.endsWith('/api/ingest/usage'));
    expect(usage.length).toBeGreaterThan(0);
    for (const b of usage) expect(validateUsageIngest(b.body).ok).toBe(true);
    expect(bodies.some((b) => b.url.endsWith('/api/ingest/limits'))).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain(TOKEN);
    expect([...out, ...err].join('\n')).not.toContain(TOKEN);

    const state = loadState(join(home, 'state.json'));
    expect(Object.keys(state.uploaded).length).toBeGreaterThan(0);

    // Second run has nothing new: one heartbeat, limits unchanged so not resent.
    bodies.length = 0;
    expect(await runSync(args, d)).toBe(0);
    const again = bodies.filter((b) => b.url.endsWith('/api/ingest/usage'));
    expect(again).toHaveLength(1);
    expect((again[0]!.body as { buckets: unknown[] }).buckets).toHaveLength(0);
    expect(bodies.some((b) => b.url.endsWith('/api/ingest/limits'))).toBe(false);
  });

  it('returns 1 and keeps rows pending when the Worker rejects', async () => {
    const { home, args } = setup(true);
    const { d } = deps({ fetch: async () => Response.json({ error: 'unauthorized' }, { status: 401 }) });
    expect(await runSync(args, d)).toBe(1);
    const cache = JSON.parse(readFileSync(join(home, 'cache.json'), 'utf8'));
    expect(cache.pending).toBeGreaterThan(0);
    expect(cache.errors.some((e: { source: string }) => e.source === 'upload')).toBe(true);
  });
});

describe('runStatus', () => {
  it('reports without touching the network', () => {
    const { args } = setup(false);
    const { d, out } = deps();
    expect(runStatus(args, d)).toBe(0);
    expect(out.join('\n')).toContain('config: none');
  });
});
