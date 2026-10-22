import { fmtInt, fmtTokens, fmtUsd } from '../../format';
import type { ActivityMetric } from './derive';

export const METRIC_LABEL: Record<ActivityMetric, string> = {
  costUsd: 'API-equivalent cost',
  tokens: 'Tokens',
  requests: 'Requests',
};

export function fmtMetric(v: number, metric: ActivityMetric): string {
  if (metric === 'costUsd') return fmtUsd(v);
  if (metric === 'tokens') return fmtTokens(v);
  return fmtInt(v);
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function fmtHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}
