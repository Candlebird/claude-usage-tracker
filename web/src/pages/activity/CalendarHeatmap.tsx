import { useMemo, useState } from 'react';
import type { CalendarDay } from '@ccu/shared';
import { fmtDayKey } from '../../format';
import { calendarColumns, levelOf, metricValue, monthLabels, quantileThresholds, type ActivityMetric } from './derive';
import { METRIC_LABEL, WEEKDAYS, fmtMetric } from './format';
import { ScaleLegend } from './ScaleLegend';

interface Props {
  days: readonly CalendarDay[];
  metric: ActivityMetric;
  /** Today's `YYYY-MM-DD` in the display tz; outlined when present. */
  today: string;
}

function monthOf(day: string): string {
  return fmtDayKey(day).split(' ')[0] ?? day;
}

/** GitHub-style calendar: one column per week, Monday at the top. */
export function CalendarHeatmap({ days, metric, today }: Props) {
  const [active, setActive] = useState<CalendarDay | null>(null);
  const cols = useMemo(() => calendarColumns(days), [days]);
  const months = useMemo(() => monthLabels(cols, monthOf), [cols]);
  const thresholds = useMemo(() => quantileThresholds(days.map((d) => metricValue(d, metric))), [days, metric]);

  const describe = (d: CalendarDay) => {
    const extra = metric === 'requests' ? '' : `, ${fmtMetric(d.requests, 'requests')} requests`;
    return `${fmtDayKey(d.day)}: ${fmtMetric(metricValue(d, metric), metric)}${extra}`;
  };

  return (
    <div className="act-heat">
      <div className="act-cal" role="img" aria-label={`${METRIC_LABEL[metric]} per day over the last ${cols.length} weeks`} onMouseLeave={() => setActive(null)}>
        <div className="act-cal-col act-cal-days" aria-hidden="true">
          <span className="act-axis act-axis-month" />
          {WEEKDAYS.map((w, i) => (
            <span key={w} className="act-axis act-axis-day">
              {i % 2 === 0 ? w : ''}
            </span>
          ))}
        </div>
        {cols.map((col, ci) => (
          <div className="act-cal-col" key={ci}>
            <span className="act-axis act-axis-month" aria-hidden="true">
              {months[ci] ?? ''}
            </span>
            {Array.from({ length: 7 }, (_, ri) => {
              const d = col[ri];
              if (!d) return <span key={ri} className="act-cell act-cell-pad" aria-hidden="true" />;
              return (
                <span
                  key={ri}
                  className="act-cell"
                  data-level={levelOf(metricValue(d, metric), thresholds)}
                  data-today={d.day === today || undefined}
                  data-active={active?.day === d.day || undefined}
                  title={describe(d)}
                  onMouseEnter={() => setActive(d)}
                  onClick={() => setActive(d)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="act-heat-foot">
        <p className="act-readout" aria-live="polite">
          {active ? describe(active) : 'Hover or tap a day for its value. Today is outlined.'}
        </p>
        <ScaleLegend />
      </div>
    </div>
  );
}
