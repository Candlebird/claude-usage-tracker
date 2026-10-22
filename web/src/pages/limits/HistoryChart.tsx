import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import type { LimitHistoryPoint, LimitHit } from '@ccu/shared';
import { fmtAxisTime, fmtDateTime, fmtPct } from '../../format';
import { resetMarkers, type Thresholds } from './model';

/** Past this many resets in view, the vertical markers become noise and are dropped. */
const MAX_RESET_LINES = 40;

export interface HistoryChartProps {
  label: string;
  points: readonly LimitHistoryPoint[];
  hits: readonly LimitHit[];
  color: string;
  thresholds: Thresholds;
  domain: readonly [number, number];
  tz: string;
  height?: number;
}

function HistoryTooltip({ tp, tz }: { tp: TooltipContentProps<ValueType, NameType>; tz: string }) {
  const p = tp.payload?.[0]?.payload as LimitHistoryPoint | undefined;
  if (!tp.active || !p) return null;
  return (
    <div className="chart-tooltip" role="presentation">
      <div className="chart-tooltip-title">{fmtDateTime(p.ts, tz)}</div>
      <table>
        <tbody>
          <tr>
            <td className="num">{fmtPct(p.utilization, 0)}</td>
            <td>used</td>
          </tr>
          <tr>
            <td className="num">{fmtDateTime(p.resetsAt, tz)}</td>
            <td>reset</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** One window's utilization over the range: 0-100 scale, threshold rules, reset rules, hit markers. */
export function HistoryChart({ label, points, hits, color, thresholds, domain, tz, height = 150 }: HistoryChartProps) {
  const resets = useMemo(() => {
    const r = resetMarkers(points).filter((t) => t >= domain[0] && t <= domain[1]);
    return r.length > MAX_RESET_LINES ? [] : r;
  }, [points, domain]);
  const span = domain[1] - domain[0];
  const data = points as LimitHistoryPoint[];

  return (
    <div className="chart-plot" style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 30, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={[domain[0], domain[1]]}
            allowDataOverflow
            tickFormatter={(t: number) => fmtAxisTime(t, tz, span)}
            tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--axis)' }}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          {resets.map((t) => (
            <ReferenceLine key={`r${t}`} x={t} stroke="var(--ink-muted)" strokeOpacity={0.45} strokeWidth={1} ifOverflow="discard" />
          ))}
          {thresholds.map((v) => (
            <ReferenceLine
              key={`t${v}`}
              y={v}
              stroke="var(--ink-muted)"
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{ value: `${v}%`, position: 'right', fill: 'var(--ink-muted)', fontSize: 10 }}
            />
          ))}
          <Area
            dataKey="utilization"
            name={label}
            type="linear"
            stroke={color}
            strokeWidth={2}
            fill={color}
            fillOpacity={0.1}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
          />
          {hits.map((h) => (
            <ReferenceDot
              key={`h${h.ts}`}
              x={h.ts}
              y={100}
              r={5}
              fill="var(--critical)"
              stroke="var(--surface)"
              strokeWidth={2}
              ifOverflow="visible"
            />
          ))}
          <Tooltip
            cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
            isAnimationActive={false}
            content={(tp: TooltipContentProps<ValueType, NameType>) => <HistoryTooltip tp={tp} tz={tz} />}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
