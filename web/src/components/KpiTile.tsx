import type { ReactNode } from 'react';
import { fmtPct } from '../format';
import { Icon } from './icons';
import { Sparkline } from './Sparkline';

export interface KpiDelta {
  /** Percent change vs the comparison period (e.g. 12.5 = +12.5%); null hides the delta. */
  pct: number | null;
  /** Comparison label, e.g. "vs prev 7d". */
  label?: string;
  /** Which direction is good. Cost going up is 'down'-is-good. Default 'up'. */
  goodWhen?: 'up' | 'down' | 'neither';
}

export interface KpiTileProps {
  label: ReactNode;
  value: ReactNode;
  /** Small line under the value (units, context). */
  sub?: ReactNode;
  delta?: KpiDelta;
  spark?: readonly number[];
  sparkColor?: string;
  /** Emphasize as the page's hero number. */
  hero?: boolean;
  refreshing?: boolean;
}

export function deltaTone(d: KpiDelta): 'good' | 'bad' | 'neutral' {
  if (d.pct == null || Math.abs(d.pct) < 0.5 || d.goodWhen === 'neither') return 'neutral';
  const up = d.pct > 0;
  return up === ((d.goodWhen ?? 'up') === 'up') ? 'good' : 'bad';
}

export function KpiTile({ label, value, sub, delta, spark, sparkColor, hero, refreshing }: KpiTileProps) {
  const tone = delta ? deltaTone(delta) : 'neutral';
  return (
    <div className={`kpi${hero ? ' kpi-hero' : ''}${refreshing ? ' is-refreshing' : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-foot">
        {delta && delta.pct != null && (
          <span className={`kpi-delta delta-${tone}`}>
            <Icon name={delta.pct >= 0 ? 'arrowUp' : 'arrowDown'} size={12} />
            {fmtPct(Math.abs(delta.pct), Math.abs(delta.pct) < 10 ? 1 : 0)}
            {delta.label && <span className="kpi-delta-label"> {delta.label}</span>}
          </span>
        )}
        {sub && <span className="kpi-sub">{sub}</span>}
      </div>
      {spark && spark.length > 1 && (
        <div className="kpi-spark">
          <Sparkline values={spark} color={sparkColor} width={120} height={28} />
        </div>
      )}
    </div>
  );
}
