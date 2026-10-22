import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { fmtDate, fmtDateTime, fmtPct } from '../../format';
import type { PaceModel, PaceRow } from './model';

export interface PaceChartProps {
  model: PaceModel;
  color: string;
  now: number;
  tz: string;
  height?: number;
}

/** Highest y shown; a runaway projection is clipped and labeled with its real value. */
const Y_CAP = 150;

function PaceTooltip({ tp, tz }: { tp: TooltipContentProps<ValueType, NameType>; tz: string }) {
  const r = tp.payload?.[0]?.payload as PaceRow | undefined;
  if (!tp.active || !r) return null;
  return (
    <div className="chart-tooltip" role="presentation">
      <div className="chart-tooltip-title">{fmtDateTime(r.t, tz)}</div>
      <table>
        <tbody>
          {r.actual != null && (
            <tr>
              <td className="num">{fmtPct(r.actual, 0)}</td>
              <td>used</td>
            </tr>
          )}
          {r.projected != null && r.actual == null && (
            <tr>
              <td className="num">{fmtPct(r.projected, 0)}</td>
              <td>projected</td>
            </tr>
          )}
          <tr>
            <td className="num">{fmtPct(r.even, 0)}</td>
            <td>even pace</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Actual usage so far, the even-pace diagonal, and the linear projection to reset. One y-axis (percent). */
export function PaceChart({ model, color, now, tz, height = 180 }: PaceChartProps) {
  const top = Math.min(Y_CAP, Math.max(100, Math.ceil(((model.projectedAtReset ?? 0) + 5) / 10) * 10));
  const ticks = top > 100 ? [0, 50, 100, top] : [0, 50, 100];
  const rows = model.rows.map((r) => (r.projected != null ? { ...r, projected: Math.min(r.projected, top) } : r));
  const clipped = model.projectedAtReset != null && model.projectedAtReset > top;

  return (
    <div className="chart-plot" style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[model.start, model.resetsAt]}
            tickFormatter={(t: number) => fmtDate(t, tz)}
            tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--axis)' }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={[0, top]}
            ticks={ticks}
            allowDataOverflow
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <ReferenceLine y={100} stroke="var(--ink-2)" strokeWidth={1} />
          {now > model.start && now < model.resetsAt && (
            <ReferenceLine x={now} stroke="var(--ink-muted)" strokeWidth={1} label={{ value: 'now', position: 'insideTopLeft', fill: 'var(--ink-muted)', fontSize: 10 }} />
          )}
          <Line dataKey="even" type="linear" stroke="var(--ink-muted)" strokeWidth={1} strokeDasharray="2 4" dot={false} activeDot={false} isAnimationActive={false} />
          <Area
            dataKey="actual"
            type="linear"
            stroke={color}
            strokeWidth={2}
            fill={color}
            fillOpacity={0.1}
            connectNulls={false}
            dot={false}
            activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <Line
            dataKey="projected"
            type="linear"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="6 4"
            connectNulls
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            label={(p: { x?: number | string; y?: number | string; index?: number }) =>
              p.index === rows.length - 1 && model.projectedAtReset != null ? (
                <text x={Number(p.x) - 4} y={Number(p.y) - 8} textAnchor="end" fill="var(--ink-2)" fontSize={11} fontWeight={600}>
                  {fmtPct(model.projectedAtReset, 0)}
                  {clipped ? ' ↑' : ''}
                </text>
              ) : (
                <g />
              )
            }
          />
          <Tooltip
            cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
            isAnimationActive={false}
            content={(tp: TooltipContentProps<ValueType, NameType>) => <PaceTooltip tp={tp} tz={tz} />}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
