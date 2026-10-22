import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { fmtAxisTime, fmtDateTime, fmtRatio, fmtWeekdayDate } from '../../format';
import { tokenTypeColor } from '../../palette';
import type { RatePoint } from './derive';

export interface HitRateChartProps {
  points: readonly RatePoint[];
  /** Range-wide hit rate (0-1), drawn as a dashed reference line. */
  average: number | null;
  tz: string;
  bucket: 'hour' | 'day';
  height?: number;
}

/** Single-series line, y fixed at 0-100%. Buckets with no traffic are gaps, not zeros. */
export function HitRateChart({ points, average, tz, bucket, height = 220 }: HitRateChartProps) {
  const span = points.length > 1 ? points[points.length - 1]!.t - points[0]!.t : 0;
  const color = tokenTypeColor('cacheRead');
  const data = points.map((p) => ({ t: p.t, rate: p.rate }));
  return (
    <figure className="chart" aria-label="Cache hit rate per bucket, 0 to 100 percent">
      <div className="chart-plot" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) => fmtAxisTime(t, tz, span)}
              tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--axis)' }}
              tickLine={false}
              minTickGap={28}
              padding={{ left: 8, right: 8 }}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => fmtRatio(v, 0)}
              tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            {average != null && (
              <ReferenceLine y={average} stroke="var(--ink-muted)" strokeDasharray="4 4" strokeWidth={1} ifOverflow="extendDomain" />
            )}
            <Tooltip
              cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
              isAnimationActive={false}
              content={(tp: TooltipContentProps<ValueType, NameType>) => {
                if (!tp.active || tp.label == null) return null;
                const t = Number(tp.label);
                const v = tp.payload?.[0]?.value;
                return (
                  <div className="chart-tooltip" role="presentation">
                    <div className="chart-tooltip-title">{bucket === 'day' ? fmtWeekdayDate(t, tz) : fmtDateTime(t, tz)}</div>
                    {v == null ? (
                      <div className="chart-tooltip-empty">No usage</div>
                    ) : (
                      <table>
                        <tbody>
                          <tr>
                            <td className="num">{fmtRatio(Number(v))}</td>
                            <td>
                              <span className="swatch" style={{ background: color }} />
                              Cache hit rate
                            </td>
                          </tr>
                          {average != null && (
                            <tr className="chart-tooltip-total">
                              <td className="num">{fmtRatio(average)}</td>
                              <td>Range average</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              }}
            />
            <Line
              dataKey="rate"
              type="monotone"
              stroke={color}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
