import type { Settings, SettingsUpdate, StatusResponse, SyncRun } from '@ccu/shared';
import { statusFor, type Status } from '../../palette';

export interface Health {
  status: Status;
  /** Short state word shown next to the status icon. */
  label: string;
}

const MINUTE = 60;
const HOUR = 3600;

/** Sync runs every 5 minutes: two missed runs is "behind", past the stale window is "stale". */
export function syncHealth(lastTs: number | null | undefined, now: number, staleMinutes: number): Health {
  if (lastTs == null) return { status: 'critical', label: 'No syncs yet' };
  const age = now - lastTs;
  if (age <= 15 * MINUTE) return { status: 'ok', label: 'Up to date' };
  if (age < Math.max(staleMinutes, 16) * MINUTE) return { status: 'warning', label: 'Behind' };
  return { status: 'critical', label: 'Stale' };
}

/** OTel only flows while Claude Code runs, so a quiet stream is normal; only "never" or days of silence are flagged. */
export function liveHealth(lastTs: number | null | undefined, now: number): Health {
  if (lastTs == null) return { status: 'warning', label: 'Never received' };
  const age = now - lastTs;
  if (age <= 10 * MINUTE) return { status: 'ok', label: 'Receiving' };
  if (age <= 72 * HOUR) return { status: 'ok', label: 'Idle' };
  return { status: 'warning', label: 'Silent' };
}

export interface Quota {
  used: number;
  limit: number;
  /** 0-100, unclamped. */
  pct: number;
  health: Health;
}

export function quotaUsage(used: number, limit: number): Quota {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const status = statusFor(pct, [70, 90]);
  const label = status === 'ok' ? 'Within free tier' : status === 'critical' ? 'Quota reached' : 'Approaching quota';
  return { used, limit, pct, health: { status, label } };
}

export function pricingHealth(unpriced: readonly string[]): Health {
  const n = unpriced.length;
  return n > 0 ? { status: 'warning', label: `${n} unpriced model${n === 1 ? '' : 's'}` } : { status: 'ok', label: 'All priced' };
}

export function dataQualityHealth(s: Pick<StatusResponse, 'unpricedModels' | 'outputIncomplete'>): Health {
  if (s.unpricedModels.length > 0) return pricingHealth(s.unpricedModels);
  if (s.outputIncomplete.requests > 0) return { status: 'ok', label: 'Minor gaps' };
  return { status: 'ok', label: 'Clean' };
}

/** Seconds until the next UTC midnight, when D1's daily counters reset. */
export function secondsToUtcMidnight(now: number): number {
  const day = 86_400;
  return day - (now % day);
}

export interface TableRow {
  table: string;
  rows: number;
  /** 0-1 share of all stored rows. */
  share: number;
}

export function toTableRows(counts: Record<string, number>): TableRow[] {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts).map(([table, rows]) => ({ table, rows, share: total > 0 ? rows / total : 0 }));
}

export function syncRunsWithin(runs: readonly SyncRun[], now: number, seconds: number): number {
  return runs.filter((r) => now - r.ts <= seconds).length;
}

/** Errors from the newest run that reported any, de-duplicated. */
export function latestErrors(runs: readonly SyncRun[]): { ts: number; errors: string[] } | null {
  const newest = [...runs].sort((a, b) => b.ts - a.ts).find((r) => r.errors.length > 0);
  return newest ? { ts: newest.ts, errors: [...new Set(newest.errors)] } : null;
}

// ---------------------------------------------------------------------------
// Alert settings form
// ---------------------------------------------------------------------------

export interface SettingsDraft {
  dailyBudgetUsd: string;
  fiveHour: string;
  weekly: string;
  weeklyPaceAlert: boolean;
  staleSyncMinutes: string;
  ntfyEnabled: boolean;
}

export type DraftErrors = Partial<Record<keyof SettingsDraft, string>>;

export function toDraft(s: Settings): SettingsDraft {
  return {
    dailyBudgetUsd: String(s.dailyBudgetUsd),
    fiveHour: s.alertThresholds.fiveHour.join(', '),
    weekly: s.alertThresholds.weekly.join(', '),
    weeklyPaceAlert: s.weeklyPaceAlert,
    staleSyncMinutes: String(s.staleSyncMinutes),
    ntfyEnabled: s.ntfyEnabled,
  };
}

/** "75, 90" -> [75, 90]. Accepts commas or spaces and an optional %; returns an error string when invalid. */
export function parseThresholds(text: string): number[] | string {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.replace(/%$/, ''))
    .filter(Boolean);
  if (parts.length === 0) return 'Enter at least one percentage.';
  if (parts.length > 4) return 'Use at most 4 thresholds.';
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n > 100)) return 'Each threshold is a percentage from 1 to 100.';
  return [...new Set(nums.map((n) => Math.round(n)))].sort((a, b) => a - b);
}

function parseNumber(text: string, min: number, max: number): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Validates the draft and returns only the fields that differ from `current`. */
export function buildUpdate(current: Settings, draft: SettingsDraft): { errors: DraftErrors; update: SettingsUpdate } {
  const errors: DraftErrors = {};
  const update: SettingsUpdate = {};

  const budget = parseNumber(draft.dailyBudgetUsd, 0, 1_000_000);
  if (budget == null) errors.dailyBudgetUsd = 'Enter 0 (off) or a positive amount.';
  else {
    const rounded = Math.round(budget * 100) / 100;
    if (rounded !== current.dailyBudgetUsd) update.dailyBudgetUsd = rounded;
  }

  const five = parseThresholds(draft.fiveHour);
  const weekly = parseThresholds(draft.weekly);
  if (typeof five === 'string') errors.fiveHour = five;
  if (typeof weekly === 'string') errors.weekly = weekly;
  if (typeof five !== 'string' && typeof weekly !== 'string') {
    if (!sameList(five, current.alertThresholds.fiveHour) || !sameList(weekly, current.alertThresholds.weekly)) {
      update.alertThresholds = { fiveHour: five, weekly };
    }
  }

  const stale = parseNumber(draft.staleSyncMinutes, 10, 24 * 60);
  if (stale == null || !Number.isInteger(stale)) errors.staleSyncMinutes = 'Whole minutes from 10 to 1440.';
  else if (stale !== current.staleSyncMinutes) update.staleSyncMinutes = stale;

  if (draft.weeklyPaceAlert !== current.weeklyPaceAlert) update.weeklyPaceAlert = draft.weeklyPaceAlert;
  if (draft.ntfyEnabled !== current.ntfyEnabled) update.ntfyEnabled = draft.ntfyEnabled;

  return { errors, update };
}

export function hasErrors(e: DraftErrors): boolean {
  return Object.values(e).some(Boolean);
}
