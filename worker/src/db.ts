// Shared D1 helpers and the Worker Env. Read routes and alerts import from here;
// keep these exports stable.
import { DEFAULT_SETTINGS, mergeSettings, type Settings, type SettingsUpdate } from '@ccu/shared';

export interface Env {
  DB: D1Database;
  READ_TOKEN: string;
  WRITE_TOKEN: string;
  /** Optional secret; alerts are off when unset. */
  NTFY_TOPIC?: string;
  /** Optional var, default https://ntfy.sh */
  NTFY_SERVER?: string;
  /** Comma-separated origins allowed by CORS. */
  ALLOWED_ORIGINS: string;
  /** IANA timezone used when a request has no `tz`. */
  TZ_NAME: string;
  /** Default daily budget in USD as a string; "0" = off. Overridden by settings. */
  DAILY_BUDGET_USD: string;
  /** Optional var: dashboard URL sent as the ntfy Click link. Empty = no link. */
  DASHBOARD_URL?: string;
}

export type Bind = string | number | null;

/** All rows of a query. */
export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: Bind[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

/** First row of a query, or null. */
export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: Bind[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

/** Runs a write; returns rows changed. */
export async function run(db: D1Database, sql: string, ...params: Bind[]): Promise<number> {
  const res = await db.prepare(sql).bind(...params).run();
  return res.meta?.changes ?? 0;
}

/** Runs prepared statements in one batch (one transaction). No-op when empty. */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return db.batch(statements);
}

// ---------------------------------------------------------------------------
// Settings: one row per Settings field, value is JSON. Keys starting with
// `meta.` hold internal worker state and are never returned as settings.
// ---------------------------------------------------------------------------

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export function defaultSettings(env: Pick<Env, 'DAILY_BUDGET_USD'>): Settings {
  const budget = Number(env.DAILY_BUDGET_USD);
  return {
    ...DEFAULT_SETTINGS,
    alertThresholds: { fiveHour: [...DEFAULT_SETTINGS.alertThresholds.fiveHour], weekly: [...DEFAULT_SETTINGS.alertThresholds.weekly] },
    dailyBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 0,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Stored settings merged over defaults. Values with the wrong type fall back to the default. */
export async function getSettings(env: Pick<Env, 'DB' | 'DAILY_BUDGET_USD'>): Promise<Settings> {
  const out = defaultSettings(env);
  const rows = await all<{ key: string; value: string }>(env.DB, "SELECT key, value FROM settings WHERE key NOT LIKE 'meta.%'");
  const record = out as unknown as Record<string, unknown>;
  for (const { key, value } of rows) {
    if (!(SETTING_KEYS as string[]).includes(key)) continue;
    const v = parseJson(value);
    const def = record[key];
    if (key === 'alertThresholds') {
      const t = v as Settings['alertThresholds'] | undefined;
      if (t && Array.isArray(t.fiveHour) && Array.isArray(t.weekly)) record[key] = { fiveHour: t.fiveHour, weekly: t.weekly };
    } else if (typeof v === typeof def) {
      record[key] = v;
    }
  }
  return out;
}

/** Applies a validated update and returns the full settings. */
export async function putSettings(env: Pick<Env, 'DB' | 'DAILY_BUDGET_USD'>, update: SettingsUpdate): Promise<Settings> {
  const merged = mergeSettings(await getSettings(env), update);
  const keys = SETTING_KEYS.filter((k) => update[k] !== undefined);
  const stmts = keys.map((k) =>
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(
      k,
      JSON.stringify(merged[k]),
    ),
  );
  await batch(env.DB, stmts);
  return merged;
}

/** Reads internal worker state stored under `meta.<name>`. */
export async function getMeta<T>(db: D1Database, name: string): Promise<T | null> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?1', `meta.${name}`);
  if (!row) return null;
  const v = parseJson(row.value);
  return v === undefined ? null : (v as T);
}

export function setMetaStatement(db: D1Database, name: string, value: unknown): D1PreparedStatement {
  return db
    .prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(`meta.${name}`, JSON.stringify(value));
}

export async function setMeta(db: D1Database, name: string, value: unknown): Promise<void> {
  await setMetaStatement(db, name, value).run();
}

/** `meta.syncStats`: the latest sync run's non-fatal stats (sync_runs has no column for them). */
export interface SyncStatsMeta {
  ts: number;
  outputIncomplete: number;
  unpricedModels: string[];
}

export const META_SYNC_STATS = 'syncStats';
