import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { validateConfig, type Config } from '@ccu/shared';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type ConfigLoad =
  | { kind: 'ok'; config: Config }
  | { kind: 'missing'; path: string }
  | { kind: 'invalid'; path: string; error: string };

/** Reads and validates `config.json`. Never throws; error text never echoes field values (tokens). */
export function readConfig(path: string): ConfigLoad {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path };
    return { kind: 'invalid', path, error: `cannot read file (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return { kind: 'invalid', path, error: 'not valid JSON' };
  }
  const v = validateConfig(body);
  return v.ok ? { kind: 'ok', config: v.value } : { kind: 'invalid', path, error: v.error };
}

/** Like readConfig, but throws a ConfigError with a message that tells the user what to do. */
export function loadConfig(path: string): Config {
  const r = readConfig(path);
  if (r.kind === 'ok') return r.config;
  if (r.kind === 'missing') throw new ConfigError(`No config at ${path}. Run \`ccu install\` first (or use --dry-run).`);
  throw new ConfigError(`Invalid config ${path}: ${r.error}. Fix the file or re-run \`ccu install\`.`);
}

/** Local settings a dry run can use without any config file. */
export interface LocalSettings {
  tz: string;
  deviceName: string;
  claudeDir?: string;
  maxRowsPerRun?: number;
}

export function localDefaults(config: Config | null): LocalSettings {
  const out: LocalSettings = {
    tz: config?.tz ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    deviceName: config?.deviceName ?? hostname(),
  };
  if (config?.claudeDir) out.claudeDir = config.claudeDir;
  if (config?.maxRowsPerRun) out.maxRowsPerRun = config.maxRowsPerRun;
  return out;
}
