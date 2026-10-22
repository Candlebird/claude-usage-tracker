import { useMemo } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import type { TimeseriesSeries } from '@ccu/shared';
import { fmtAxisTime, fmtCompact, fmtDateTime, fmtWeekdayDate } from '../../format';
import { OTHER_COLOR, OTHER_KEY, seriesColor } from '../../palette';
import { TooltipRows } from './ChartTooltip';
import { Legend } from './Legend';
import { foldOther, toRows, type ChartSeries } from './series';

export interface TimeChartProps {
  series: readonly TimeseriesSeries[];
  /** Color per series key. Must follow the entity (model, project), not its rank. Defaults to input order. */
  colorFor?: (key: string, index: number) => string;
  labelFor?: (key: string) => string;
  /** Value formatter for tooltip rows. */
  format?: (v: number) => string;
  /** Axis tick formatter; defaults to compact numbers. */
  axisFormat?: (v: number) => string;
  tz: string;
  /** 'hour' buckets show date+time in the tooltip, 'day' shows the date. */
  bucket?: 'hour' | 'day';
  height?: number;
  /** Adds the API-equivalent note to the tooltip. */
  costNote?: boolean;
  /** Accessible description of what the chart shows. */
  ariaLabel: string;
}

interface Prepared {
  rows: ReturnType<typeof toRows>;
  series: ChartSeries[];
  span: number;
}

function usePrepared(p: TimeChartProps): Prepared {
  const { series, colorFor, labelFor } = p;
  return useMemo(() => {
    const folded = foldOther(series);
    const chartSeries = folded.map((s, i) => ({
      key: s.key,
      label: s.key === OTHER_KEY ? (s.label ?? 'Other') : (labelFor?.(s.key) ?? s.label ?? s.key),
      color: s.key === OTHER_KEY ? OTHER_COLOR : (colorFor?.(s.key, i) ?? seriesColor(i)),
    }));
    const rows = toRows(folded);
    const span = rows.length > 1 ? rows[rows.length - 1]!.t - rows[0]!.t : 0;
    return { rows, series: chartSeries, span };
  }, [series, colorFor, labelFor]);
}

function tooltipTitle(t: number, tz: string, bucket: 'hour' | 'day'): string {
  return bucket === 'day' ? fmtWeekdayDate(t, tz) : fmtDateTime(t, tz);
}

/** Shared axis/grid/tooltip parts so area and bar charts read as one system. */
function chrome(p: TimeChartProps, prep: Prepared, cursor: object | false) {
  const format = p.format ?? ((v: number) => fmtCompact(v));
  const axisFormat = p.axisFormat ?? ((v: number) => fmtCompact(v, 0));
  const bucket = p.bucket ?? 'hour';
  return [
    <CartesianGrid key="grid" vertical={false} stroke="var(--grid)" />,
    <XAxis
      key="x"
      dataKey="t"
      type="number"
      scale="time"
      domain={['dataMin', 'dataMax']}
      tickFormatter={(t: number) => fmtAxisTime(t, p.tz, prep.span)}
      tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
      axisLine={{ stroke: 'var(--axis)' }}
      tickLine={false}
      minTickGap={28}
      padding={{ left: 8, right: 8 }}
    />,
    <YAxis
      key="y"
      tickFormatter={axisFormat}
      tick={{ fill: 'var(--ink-muted)', fontSize: 11 }}
      axisLine={false}
      tickLine={false}
      width={44}
    />,
    <Tooltip
      key="tip"
      cursor={cursor}
      isAnimationActive={false}
      content={(tp: TooltipContentProps<ValueType, NameType>) =>
        tp.active && tp.label != null ? (
          <TooltipRows
            title={tooltipTitle(Number(tp.label), p.tz, bucket)}
            series={prep.series}
            values={Object.fromEntries((tp.payload ?? []).map((e) => [String(e.dataKey), Number(e.value)]))}
            format={format}
            costNote={p.costNote}
          />
        ) : null
      }
    />,
  ];
}

/** Stacked area over time. 2px lines, ~10% fills, crosshair tooltip, legend for 2+ series. */
export function StackedAreaChart(p: TimeChartProps) {
  const prep = usePrepared(p);
  return (
    <figure className="chart" aria-label={p.ariaLabel}>
      <Legend series={prep.series} />
      <div className="chart-plot" style={{ height: p.height ?? 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={prep.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {chrome(p, prep, { stroke: 'var(--axis)', strokeWidth: 1 })}
            {prep.series.map((s) => (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="1"
                type="monotone"
                stroke={s.color}
                strokeWidth={2}
                fill={s.color}
                fillOpacity={0.1}
                isAnimationActive={false}
                activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
                dot={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Stacked bars over time. Bars <= 24px, 4px rounded top on the last segment, 2px surface gap between segments. */
export function StackedBarChart(p: TimeChartProps) {
  const prep = usePrepared(p);
  const last = prep.series.length - 1;
  return (
    <figure className="chart" aria-label={p.ariaLabel}>
      <Legend series={prep.series} />
      <div className="chart-plot" style={{ height: p.height ?? 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={prep.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
            {chrome(p, prep, { fill: 'var(--wash)' })}
            {prep.series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="1"
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth={2}
                maxBarSize={24}
                radius={i === last ? [4, 4, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
