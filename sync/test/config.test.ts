import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, localDefaults, readConfig } from '../src/config.js';

const dir = () => mkdtempSync(join(tmpdir(), 'ccu-config-'));
const valid = { apiUrl: 'https://example.invalid', writeToken: 'w'.repeat(40), tz: 'America/Denver', deviceName: 'test-pc' };

describe('config', () => {
  it('reports a missing file', () => {
    const p = join(dir(), 'config.json');
    expect(readConfig(p)).toEqual({ kind: 'missing', path: p });
    expect(() => loadConfig(p)).toThrow(ConfigError);
    expect(() => loadConfig(p)).toThrow(/ccu install/);
  });

  it('reports invalid JSON without echoing content', () => {
    const p = join(dir(), 'config.json');
    writeFileSync(p, '{"writeToken": "secret-value"');
    const r = readConfig(p);
    expect(r.kind).toBe('invalid');
    expect(JSON.stringify(r)).not.toContain('secret-value');
  });

  it('loads a valid config, tolerating a BOM', () => {
    const p = join(dir(), 'config.json');
    writeFileSync(p, '﻿' + JSON.stringify(valid));
    expect(loadConfig(p).deviceName).toBe('test-pc');
  });

  it('local defaults work without a config', () => {
    const d = localDefaults(null);
    expect(d.tz.length).toBeGreaterThan(0);
    expect(d.deviceName.length).toBeGreaterThan(0);
    expect(localDefaults({ ...valid, maxRowsPerRun: 10 }).maxRowsPerRun).toBe(10);
  });
});
