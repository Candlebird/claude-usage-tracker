import type { TimeseriesSeries } from '@ccu/shared';
import { AsyncView, Card, CostNote, EmptyState, StackedAreaChart, isAllZero } from '../../components';
import { fmtRatio, fmtUsd } from '../../format';
import { useApi } from '../../hooks/useApi';
import { useModelSeriesStyle } from '../shared';
import { lastWeekHourly, seriesTotals } from './model';

/** Per-model 7-day totals: the numeric companion to the stacked chart. */
function ModelTotals({ series, colorFor, labelFor }: { series: readonly TimeseriesSeries[]; colorFor: (k: string) => string; labelFor: (k: string) => string }) {
  const totals = seriesTotals(series);
  return (
    <table className="data-table ov-mini-table">
      <caption className="sr-only">Cost by model, last 7 days</caption>
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col" className="num">
            Cost
          </th>
          <th scope="col" className="num">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {totals.map((t) => (
          <tr key={t.key}>
            <td>
              <span className="swatch" style={{ background: colorFor(t.key) }} aria-hidden="true" />
              {labelFor(t.key)}
            </td>
            <td className="num">{fmtUsd(t.total)}</td>
            <td className="num">{fmtRatio(t.share)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Always the trailing 7 days at hourly resolution, independent of the global range. */
export function CostByModel({ now, tz }: { now: number; tz: string }) {
  const { from, to } = lastWeekHourly(now);
  const state = useApi((c, signal) => c.timeseries({ from, to, bucket: 'hour', group: 'model', metric: 'cost', tz }, { signal }), [from, to, tz]);
  const style = useModelSeriesStyle(state.data?.series);
  return (
    <Card title="Cost by model" subtitle="Last 7 days, hourly, USD" refreshing={state.refreshing} footer={<CostNote />} className="ov-cost-card">
      <AsyncView
        state={state}
        isEmpty={(d) => isAllZero(d.series)}
        empty={<EmptyState title="No usage in the last 7 days">Costs appear here after the sync client uploads its first buckets.</EmptyState>}
        skeletonHeight={260}
      >
        {(d) => (
          <div className="ov-cost-body">
            <StackedAreaChart
              series={d.series}
              {...style}
              tz={tz}
              bucket="hour"
              format={(v) => fmtUsd(v)}
              axisFormat={(v) => fmtUsd(v, { compact: true })}
              costNote
              height={240}
              ariaLabel="Hourly API-equivalent cost by model over the last 7 days"
            />
            <ModelTotals series={d.series} {...style} />
          </div>
        )}
      </AsyncView>
    </Card>
  );
}
