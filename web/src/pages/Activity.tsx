import { useMemo, useState, type ReactNode } from 'react';
import { dayKey, type HeatmapResponse, type LiveRequest } from '@ccu/shared';
import { AsyncView, Card, CostNote, DataTable, EmptyState, KpiTile, Segmented, StackedBarChart, type Column, type SegmentOption } from '../components';
import { fmtInt, fmtMs, fmtRelative, fmtTime, fmtTokens, fmtUsd, modelLabel } from '../format';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import { useControls } from '../state/controls';
import { CalendarHeatmap } from './activity/CalendarHeatmap';
import { HourHeatmap } from './activity/HourHeatmap';
import { peakStats, streaks, type ActivityMetric } from './activity/derive';
import { METRIC_LABEL, WEEKDAYS, fmtHour, fmtMetric } from './activity/format';
import './activity/activity.css';

const WEEKS = 12;
const LIVE_MINUTES = 60;

const METRIC_OPTIONS: readonly SegmentOption<ActivityMetric>[] = [
  { value: 'costUsd', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'requests', label: 'Requests' },
];

function liveTokens(r: LiveRequest): number {
  return (r.input ?? 0) + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite5m ?? 0) + (r.cacheWrite1h ?? 0);
}

export default function Activity() {
  const { tz, now: tickNow } = useControls();
  const [metric, setMetric] = useState<ActivityMetric>('costUsd');
  const heat = useApi((c, signal) => c.heatmap({ weeks: WEEKS, tz }, { signal }), [tz]);
  const costNote = metric === 'costUsd' ? <CostNote compact /> : undefined;

  return (
    <div className="page">
      <div className="act-filters">
        <p>Last {WEEKS} weeks in your time zone ({tz}). Not affected by the date range.</p>
        <Segmented<ActivityMetric> options={METRIC_OPTIONS} value={metric} onChange={setMetric} label="Heatmap metric" size="sm" />
      </div>

      <AsyncView state={heat} isEmpty={(d) => d.calendar.every((x) => x.requests === 0)} empty={<EmptyState title="No activity yet">Usage appears here after the first sync.</EmptyState>}>
        {(d, refreshing) => <HeatSection data={d} metric={metric} tz={tz} now={tickNow} refreshing={refreshing} costNote={costNote} />}
      </AsyncView>

      <LiveSection />
    </div>
  );
}

interface HeatProps {
  data: HeatmapResponse;
  metric: ActivityMetric;
  tz: string;
  now: number;
  refreshing: boolean;
  costNote: ReactNode;
}

function HeatSection({ data, metric, tz, now, refreshing, costNote }: HeatProps) {
  const peaks = useMemo(() => peakStats(data.grid, metric), [data.grid, metric]);
  const streak = useMemo(() => streaks(data.calendar), [data.calendar]);
  const label = METRIC_LABEL[metric];
  const share = (v: number) => (peaks.total > 0 ? ` (${Math.round((v / peaks.total) * 100)}% of ${metric === 'costUsd' ? 'cost' : metric})` : '');

  return (
    <>
      <div className="kpi-row">
        <KpiTile
          hero
          label="Busiest hour"
          value={peaks.peakHour ? `${fmtHour(peaks.peakHour.index)}` : '—'}
          sub={peaks.peakHour ? `${fmtMetric(peaks.peakHour.value, metric)}${share(peaks.peakHour.value)}` : 'no activity'}
          refreshing={refreshing}
        />
        <KpiTile
          label="Busiest weekday"
          value={peaks.peakWeekday ? WEEKDAYS[peaks.peakWeekday.index] : '—'}
          sub={peaks.peakWeekday ? fmtMetric(peaks.peakWeekday.value, metric) : 'no activity'}
          refreshing={refreshing}
        />
        <KpiTile label="Active days" value={`${streak.activeDays} of ${data.calendar.length}`} sub={`last ${data.weeks} weeks`} refreshing={refreshing} />
        <KpiTile label="Current streak" value={`${streak.current} ${streak.current === 1 ? 'day' : 'days'}`} sub={`longest ${streak.longest}`} refreshing={refreshing} />
      </div>
      {metric === 'costUsd' && <CostNote />}

      <div className="act-grid">
        <Card title="When you work" subtitle={`${label} by weekday and hour`} refreshing={refreshing} footer={costNote}>
          <HourHeatmap grid={data.grid} metric={metric} weeks={data.weeks} />
        </Card>
        <Card title="Daily activity" subtitle={`${label} per day`} refreshing={refreshing} footer={costNote}>
          <CalendarHeatmap days={data.calendar} metric={metric} today={dayKey(now, tz)} />
        </Card>
      </div>
    </>
  );
}

function LiveSection() {
  const { tz } = useControls();
  const now = useNow(5000);
  const live = useApi((c, signal) => c.live(LIVE_MINUTES, { signal }), [], { auto: 'live' });

  const cols: Column<LiveRequest>[] = [
    { key: 'ts', header: 'Time', sortValue: (r) => r.ts, render: (r) => fmtTime(r.ts, tz), firstDir: 'desc' },
    { key: 'model', header: 'Model', sortValue: (r) => r.model, render: (r) => modelLabel(r.model) },
    { key: 'tokens', header: 'Tokens', sortValue: liveTokens, render: (r) => fmtTokens(liveTokens(r)), numeric: true },
    { key: 'dur', header: 'Duration', sortValue: (r) => r.durationMs, render: (r) => fmtMs(r.durationMs), numeric: true, hideOnMobile: true },
    { key: 'ttft', header: 'TTFT', sortValue: (r) => r.ttftMs, render: (r) => fmtMs(r.ttftMs), numeric: true, hideOnMobile: true },
    { key: 'cost', header: 'Cost', sortValue: (r) => r.costUsd, render: (r) => <span title="API-equivalent cost">{fmtUsd(r.costUsd)}</span>, numeric: true },
  ];

  return (
    <Card
      title="Live requests"
      subtitle={live.data ? `Last ${live.data.minutes} min, last event ${fmtRelative(live.data.lastReceivedTs, now)}` : `Last ${LIVE_MINUTES} min`}
      refreshing={live.refreshing}
      footer={<CostNote />}
    >
      <AsyncView
        state={live}
        isEmpty={(d) => d.perMinute.every((p) => p.requests === 0) && d.recent.length === 0}
        empty={<EmptyState title="No live requests">Live data arrives through OpenTelemetry while Claude Code is running.</EmptyState>}
      >
        {(d, refreshing) => (
          <>
            <StackedBarChart
              series={[{ key: 'requests', label: 'Requests', points: d.perMinute.map((p) => [p.t, p.requests] as [number, number]) }]}
              tz={tz}
              bucket="hour"
              format={(v) => fmtInt(v)}
              height={160}
              ariaLabel="Requests per minute"
            />
            <DataTable
              columns={cols}
              rows={d.recent}
              rowKey={(r) => r.requestId}
              initialSort={{ key: 'ts', dir: 'desc' }}
              caption="Recent requests. Costs are API-equivalent."
              refreshing={refreshing}
              empty={<EmptyState title="No recent requests" />}
            />
          </>
        )}
      </AsyncView>
    </Card>
  );
}
