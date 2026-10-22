import { DAY, HOUR, type TimeRange, type TimeseriesBucket, type UnixSeconds } from '@ccu/shared';

export type RangePreset = '24h' | '7d' | '30d' | '90d' | 'custom';
export const RANGE_PRESETS: readonly Exclude<RangePreset, 'custom'>[] = ['24h', '7d', '30d', '90d'];

export const PRESET_SECONDS: Record<Exclude<RangePreset, 'custom'>, number> = {
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
};

export const PRESET_LABEL: Record<RangePreset, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  custom: 'Custom',
};

export interface RangeState {
  preset: RangePreset;
  /** Only used when preset is 'custom'. */
  custom: TimeRange | null;
}

/** Concrete [from, to] for the state at `now`. Preset ranges snap `to` to the minute so refetch keys stay stable. */
export function resolveRange(state: RangeState, now: UnixSeconds): TimeRange {
  if (state.preset === 'custom' && state.custom && state.custom.to > state.custom.from) {
    return { from: state.custom.from, to: Math.min(state.custom.to, now) };
  }
  const len = PRESET_SECONDS[state.preset === 'custom' ? '7d' : state.preset];
  const to = Math.floor(now / 60) * 60;
  return { from: to - len, to };
}

/** Hourly buckets up to 3 days, daily beyond. */
export function bucketFor(range: TimeRange): TimeseriesBucket {
  return range.to - range.from <= 3 * DAY + HOUR ? 'hour' : 'day';
}

export function isRangePreset(v: string | null | undefined): v is RangePreset {
  return v === 'custom' || (RANGE_PRESETS as readonly string[]).includes(v ?? '');
}

/** `YYYY-MM-DD` from an <input type="date"> to local-midnight unix seconds (browser timezone). */
export function dateInputToUnix(value: string, endOfDay = false): UnixSeconds | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (endOfDay ? 1 : 0));
  return Math.floor(d.getTime() / 1000);
}

/** Unix seconds to the browser-local `YYYY-MM-DD` an <input type="date"> expects. */
export function unixToDateInput(ts: UnixSeconds): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
