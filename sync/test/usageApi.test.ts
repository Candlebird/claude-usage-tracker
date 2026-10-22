import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fetchUsage, parseUsage, pollLimits, readAccessToken, shouldUploadLimits, snapshotSignature } from '../src/usageApi.js';

// Synthetic body with the same shape as the real endpoint (values invented).
const sample = {
  five_hour: { utilization: 42.5, resets_at: '2026-03-01T15:00:00.412345+00:00', limit_dollars: null },
  seven_day: { utilization: 61.0, resets_at: '2026-03-04T09:00:00.998877+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12.25, resets_at: '2026-03-04T09:00:00.100000+00:00' },
  seven_day_oauth_apps: null,
  seven_day_cowork: null,
  some_codename: { utilization: 99 },
  extra_usage: { is_enabled: false },
  seven_day_breakdown: { anything: 1 },
  spend: { total: 3 },
  limits: [
    { kind: 'session', group: 'session', percent: 43, severity: 'normal', resets_at: '2026-03-01T15:00:00+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 61, severity: 'warning', resets_at: '2026-03-04T09:00:00+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 77,
      severity: 'normal',
      resets_at: '2026-03-05T10:00:30+00:00',
      scope: { model: { id: null, display_name: 'Testmodel' }, surface: null },
      is_active: false,
    },
    { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: '2026-03-05T10:00:00+00:00', scope: null },
  ],
};

const NOW = 1772370000;

describe('parseUsage', () => {
  const { snapshot, extraUsageEnabled } = parseUsage(sample, NOW);
  const byKey = Object.fromEntries(snapshot.windows.map((w) => [w.key, w]));

  it('maps top-level windows with float utilization and minute-rounded resets', () => {
    expect(byKey['five_hour']).toMatchObject({ label: '5-hour session', utilization: 42.5, severity: 'normal', isActive: true });
    expect(Date.parse(byKey['five_hour']!.resetsAt)).toBe(Date.parse('2026-03-01T15:00:00Z'));
    expect(byKey['seven_day']).toMatchObject({ label: 'Weekly (all models)', utilization: 61, severity: 'warning', isActive: false });
    expect(Date.parse(byKey['seven_day']!.resetsAt)).toBe(Date.parse('2026-03-04T09:00:00Z'));
    expect(byKey['seven_day:sonnet']).toMatchObject({ label: 'Weekly (Sonnet)', utilization: 12.25 });
  });

  it('adds per-model weekly windows from limits[]', () => {
    expect(byKey['seven_day:testmodel']).toMatchObject({ label: 'Weekly (Testmodel)', utilization: 77, severity: 'normal' });
  });

  it('ignores nulls, codenames, unscoped weekly_scoped and other fields', () => {
    expect(Object.keys(byKey).sort()).toEqual(['five_hour', 'seven_day', 'seven_day:sonnet', 'seven_day:testmodel']);
    expect(snapshot.windows[0]!.key).toBe('five_hour');
    expect(snapshot.ts).toBe(NOW);
    expect(extraUsageEnabled).toBe(false);
  });

  it('tolerates junk', () => {
    expect(parseUsage(null, NOW).snapshot.windows).toEqual([]);
    expect(parseUsage({ five_hour: { utilization: 'x', resets_at: 'y' }, limits: 'no' }, NOW).snapshot.windows).toEqual([]);
    expect(parseUsage({ five_hour: { utilization: 5000, resets_at: '2026-03-01T15:00:00Z' } }, NOW).snapshot.windows[0]!.utilization).toBe(1000);
  });
});

describe('credentials and fetch', () => {
  const creds = (o: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), 'ccu-cred-')), '.credentials.json');
    writeFileSync(p, JSON.stringify(o));
    return p;
  };
  const TOKEN = 'synthetic-token-value';

  it('reads the token and refuses expired ones', () => {
    expect(readAccessToken(creds({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 2e12 } }), 1e12)).toEqual({ ok: true, token: TOKEN });
    const r = readAccessToken(creds({ claudeAiOauth: { accessToken: TOKEN, expiresAt: 1 } }), 1e12);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(readAccessToken(join(tmpdir(), 'nope-ccu', 'x.json')).ok).toBe(false);
  });

  it('sends a bearer header and never leaks the token in errors', async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response('denied', { status: 401 }));
    const r = await fetchUsage(TOKEN, { fetch: f });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const init = f.mock.calls[0]![1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('times out', async () => {
    const f = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)));
    const r = await fetchUsage(TOKEN, { fetch: f, timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, error: 'usage API timed out' });
  });

  it('polls end to end', async () => {
    const p = creds({ claudeAiOauth: { accessToken: TOKEN } });
    const r = await pollLimits(p, NOW, { fetch: async () => Response.json(sample) });
    expect(r.ok && r.parsed.snapshot.windows.length).toBe(4);
  });
});

describe('limits upload gating', () => {
  const s = parseUsage(sample, NOW).snapshot;
  it('uploads when first, changed, or stale', () => {
    expect(shouldUploadLimits({ lastUploadTs: null, signature: null }, s, NOW)).toBe(true);
    const sig = snapshotSignature(s);
    expect(shouldUploadLimits({ lastUploadTs: NOW - 60, signature: sig }, s, NOW)).toBe(false);
    expect(shouldUploadLimits({ lastUploadTs: NOW - 60, signature: 'other' }, s, NOW)).toBe(true);
    expect(shouldUploadLimits({ lastUploadTs: NOW - 900, signature: sig }, s, NOW)).toBe(true);
  });
});
