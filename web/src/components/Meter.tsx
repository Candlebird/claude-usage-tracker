import type { LimitWindowStatus } from '@ccu/shared';
import { fmtCountdown, fmtDateTime, fmtPct } from '../format';
import { STATUS_COLOR, STATUS_LABEL, statusFor, type Status } from '../palette';
import { Icon, type IconName } from './icons';

const STATUS_ICON: Record<Status, IconName> = { ok: 'check', warning: 'alert', serious: 'alert', critical: 'octagon' };

export interface MeterProps {
  /** 0-100 (values above 100 are clamped in the bar, shown as-is in text). */
  value: number;
  /** Where an even pace would be right now, 0-100 (the elapsed share of the window). */
  pace?: number | null;
  /** Accessible name, e.g. "Weekly (all models)". */
  label: string;
  /** Warning / serious thresholds in percent. */
  thresholds?: readonly [number, number];
  size?: 'sm' | 'md';
}

/** Horizontal bar meter. Fill uses the reserved status color; the pace marker is a thin tick. */
export function Meter({ value, pace, label, thresholds, size = 'md' }: MeterProps) {
  const status = statusFor(value, thresholds);
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`meter meter-${size}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${fmtPct(value, 0)} used, ${STATUS_LABEL[status]}`}
    >
      <div className="meter-fill" style={{ width: `${pct}%`, background: STATUS_COLOR[status] }} />
      {pace != null && pace > 0 && pace < 100 && <div className="meter-pace" style={{ left: `${pace}%` }} title={`Even pace: ${fmtPct(pace, 0)}`} />}
    </div>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status-badge status-${status}`}>
      <Icon name={STATUS_ICON[status]} size={14} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export interface LimitGaugeProps {
  window: LimitWindowStatus;
  now: number;
  tz: string;
  thresholds?: readonly [number, number];
}

/**
 * One plan-limit window: big percentage, status badge (icon + label, never color
 * alone), meter with an even-pace marker, reset countdown and projection.
 */
export function LimitGauge({ window: w, now, tz, thresholds }: LimitGaugeProps) {
  const status = statusFor(w.utilization, thresholds);
  const pace = w.elapsedFraction > 0 ? w.elapsedFraction * 100 : null;
  const ahead = w.pace != null && w.pace > 1.05;
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="gauge-label">{w.label}</span>
        <StatusBadge status={status} />
      </div>
      <div className="gauge-value">{fmtPct(w.utilization, 0)}</div>
      <Meter value={w.utilization} pace={pace} label={w.label} thresholds={thresholds} />
      <div className="gauge-foot">
        <span title={fmtDateTime(w.resetsAt, tz)}>
          <Icon name="clock" size={13} /> Resets in {fmtCountdown(w.resetsAt, now)}
        </span>
        {w.projectedAtReset != null && (
          <span className={ahead ? 'gauge-proj gauge-proj-ahead' : 'gauge-proj'}>
            {w.projectedFullAt != null && w.projectedFullAt < w.resetsAt
              ? `Full in ${fmtCountdown(w.projectedFullAt, now)} at this pace`
              : `About ${fmtPct(Math.min(w.projectedAtReset, 999), 0)} at reset`}
          </span>
        )}
      </div>
    </div>
  );
}
