import { useMemo, useState } from 'react';
import type { HeatmapCell } from '@ccu/shared';
import { levelOf, metricValue, mondayIndex, peakStats, quantileThresholds, type ActivityMetric } from './derive';
import { METRIC_LABEL, WEEKDAYS, fmtHour, fmtMetric } from './format';
import { ScaleLegend } from './ScaleLegend';

interface Props {
  grid: readonly HeatmapCell[];
  metric: ActivityMetric;
  weeks: number;
}

type Slot = { wd: number; hour: number; cell: HeatmapCell | undefined };

/** Weekday x hour grid, Monday first. Quantile-binned on one sequential hue; hover or tap shows the exact value. */
export function HourHeatmap({ grid, metric, weeks }: Props) {
  const [active, setActive] = useState<Slot | null>(null);
  const { rows, thresholds } = useMemo(() => {
    const byKey = new Map(grid.map((c) => [`${mondayIndex(c.dow)}-${c.hour}`, c]));
    const rows = WEEKDAYS.map((_, wd) => Array.from({ length: 24 }, (_, hour): Slot => ({ wd, hour, cell: byKey.get(`${wd}-${hour}`) })));
    return { rows, thresholds: quantileThresholds(grid.map((c) => metricValue(c, metric))) };
  }, [grid, metric]);
  const stats = useMemo(() => peakStats(grid, metric), [grid, metric]);

  const describe = (s: Slot) => {
    const v = metricValue(s.cell, metric);
    const extra = metric === 'requests' ? '' : `, ${fmtMetric(s.cell?.requests ?? 0, 'requests')} requests`;
    return `${WEEKDAYS[s.wd]} ${fmtHour(s.hour)}: ${fmtMetric(v, metric)}${extra}`;
  };

  return (
    <div className="act-heat">
      <div
        className="act-hour-grid"
        role="img"
        aria-label={`${METRIC_LABEL[metric]} by weekday and hour over the last ${weeks} weeks`}
        onMouseLeave={() => setActive(null)}
      >
        <span aria-hidden="true" />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="act-axis act-axis-hour" aria-hidden="true">
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
        {rows.map((row, wd) => (
          <HourRow key={wd} label={WEEKDAYS[wd]!} row={row} metric={metric} thresholds={thresholds} active={active} onActive={setActive} describe={describe} />
        ))}
      </div>
      <div className="act-heat-foot">
        <p className="act-readout" aria-live="polite">
          {active ? describe(active) : 'Hover or tap a cell for its value.'}
        </p>
        <ScaleLegend />
      </div>
      <details className="act-details">
        <summary>Totals by weekday and hour</summary>
        <div className="act-totals">
          <TotalsTable caption={`${METRIC_LABEL[metric]} by weekday`} head="Weekday" metric={metric} rows={stats.byWeekday.map((v, i) => [WEEKDAYS[i]!, v])} />
          <TotalsTable caption={`${METRIC_LABEL[metric]} by hour of day`} head="Hour" metric={metric} rows={stats.byHour.map((v, h) => [fmtHour(h), v])} />
        </div>
      </details>
    </div>
  );
}

function TotalsTable({ caption, head, metric, rows }: { caption: string; head: string; metric: ActivityMetric; rows: [string, number][] }) {
  return (
    <table className="act-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{head}</th>
          <th scope="col" className="num">
            {METRIC_LABEL[metric]}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, v]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="num">{fmtMetric(v, metric)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface RowProps {
  label: string;
  row: Slot[];
  metric: ActivityMetric;
  thresholds: readonly number[];
  active: Slot | null;
  onActive(s: Slot): void;
  describe(s: Slot): string;
}

function HourRow({ label, row, metric, thresholds, active, onActive, describe }: RowProps) {
  return (
    <>
      <span className="act-axis act-axis-day" aria-hidden="true">
        {label}
      </span>
      {row.map((s) => (
        <span
          key={s.hour}
          className="act-cell"
          data-level={levelOf(metricValue(s.cell, metric), thresholds)}
          data-active={(active?.wd === s.wd && active.hour === s.hour) || undefined}
          title={describe(s)}
          onMouseEnter={() => onActive(s)}
          onClick={() => onActive(s)}
        />
      ))}
    </>
  );
}
