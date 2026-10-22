// One-time import of ~/.claude/stats-cache.json daily totals for days before the first transcript.
// stats-cache has per-model daily *token* totals but no per-model request counts, so `requests` is
// always 0 in the rows we send (dailyActivity.messageCount is per day across models, not per model).
import { readFileSync } from 'node:fs';
import { cleanModelId, dayKey, type DailyLegacyRow, type DayKey } from '@ccu/shared';
import type { SyncState } from './state.js';

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type StatsCacheRead = { ok: true; rows: DailyLegacyRow[] } | { ok: false; error: string };

/** Parses the stats-cache body into rows, one per (day, model). Malformed entries are skipped. */
export function parseStatsCache(body: unknown): DailyLegacyRow[] {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const daily = Array.isArray(o.dailyModelTokens) ? o.dailyModelTokens : [];
  const sums = new Map<string, DailyLegacyRow>();
  for (const d of daily) {
    if (!d || typeof d !== 'object') continue;
    const day = (d as any).date;
    const byModel = (d as any).tokensByModel;
    if (typeof day !== 'string' || !DAY_RE.test(day) || !byModel || typeof byModel !== 'object') continue;
    for (const [rawModel, tokens] of Object.entries(byModel as Record<string, unknown>)) {
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) continue;
      const model = cleanModelId(rawModel);
      if (!model || model === '<synthetic>') continue;
      const key = `${day}\t${model}`;
      const row = sums.get(key) ?? { day, model, tokens: 0, requests: 0 };
      row.tokens += Math.round(tokens);
      sums.set(key, row);
    }
  }
  return [...sums.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}

export function readStatsCache(path: string): StatsCacheRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, error: `no stats cache at ${path}` };
  }
  try {
    return { ok: true, rows: parseStatsCache(JSON.parse(raw)) };
  } catch {
    return { ok: false, error: 'stats cache is not valid JSON' };
  }
}

/** Local day of the earliest request in state, or null when there are none. */
export function earliestTranscriptDay(state: SyncState, tz: string): DayKey | null {
  let min = Infinity;
  for (const rec of Object.values(state.reqs)) if (rec[0] < min) min = rec[0];
  return Number.isFinite(min) ? dayKey(min, tz) : null;
}

/** Keeps only days strictly before the first transcript day (those are covered by real buckets). */
export function rowsBefore(rows: readonly DailyLegacyRow[], firstDay: DayKey | null): DailyLegacyRow[] {
  return firstDay == null ? [...rows] : rows.filter((r) => r.day < firstDay);
}

export function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
