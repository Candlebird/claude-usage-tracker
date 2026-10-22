import { useMemo, useState } from 'react';
import { TOKEN_TYPES, type ModelRow, type TimeseriesResponse } from '@ccu/shared';
import { AsyncView, Card, CostNote, DataTable, EmptyState, KpiTile, Segmented, StackedBarChart, isAllZero, type Column, type SegmentOption } from '../components';
import { fmtDateTime, fmtInt, fmtRatio, fmtTokens, fmtUsd, fmtWeekdayDate, modelLabel, tokenTypeLabel } from '../format';
import { useApi, type ApiState } from '../hooks/useApi';
import { modelColorMap, tokenTypeColor } from '../palette';
import { useControls } from '../state/controls';
import { HitRateChart } from './models/HitRateChart';
import { MixBar, TypeSwatch } from './models/MixBar';
import {
  hitRate,
  hitRateSeries,
  mixParts,
  orderByType,
  pickTypes,
  rateStats,
  totalsFromModels,
  typeTotals,
  writeSplit,
  type TypeTotals,
} from './models/derive';
import './models/models.css';

type Metric = 'tokens' | 'cost';
const METRIC_OPTIONS: readonly SegmentOption<Metric>[] = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
];

const typeStyle = { colorFor: (k: string) => tokenTypeColor(k), labelFor: (k: string) => tokenTypeLabel(k) };

function fmtFor(metric: Metric) {
  return metric === 'cost' ? (v: number) => fmtUsd(v) : (v: number) => fmtTokens(v);
}

export default function Models() {
  const { range, bucket, tz } = useControls();
  const [mixMetric, setMixMetric] = useState<Metric>('tokens');
  const [modelMetric, setModelMetric] = useState<Metric>('cost');
  const rangeDeps = [range.from, range.to, bucket, tz];

  const models = useApi((c, signal) => c.models(range, { signal }), [range.from, range.to]);
  const typeTokens = useApi((c, signal) => c.timeseries({ ...range, bucket, group: 'type', metric: 'tokens', tz }, { signal }), rangeDeps);
  const typeCost = useApi((c, signal) => c.timeseries({ ...range, bucket, group: 'type', metric: 'cost', tz }, { signal }), rangeDeps);
  const byModel = useApi(
    (c, signal) => c.timeseries({ ...range, bucket, group: 'model', metric: modelMetric, tz }, { signal }),
    [...rangeDeps, modelMetric],
  );

  const rows = models.data?.models;
  const totals = useMemo(() => totalsFromModels(rows ?? []), [rows]);

  // One color map for the whole page, so a model keeps its color in the chart and the table.
  const modelKeys = useMemo(
    () => [...new Set([...(rows ?? []).map((m) => m.model), ...(byModel.data?.series ?? []).map((s) => s.key)])].sort(),
    [rows, byModel.data],
  );
  const colors = useMemo(() => modelColorMap(modelKeys), [modelKeys]);
  const modelStyle = useMemo(
    () => ({ colorFor: (k: string) => colors.get(k) ?? 'var(--series-other)', labelFor: (k: string) => modelLabel(k) }),
    [colors],
  );

  const mixState: ApiState<TimeseriesResponse> = mixMetric === 'cost' ? typeCost : typeTokens;
  const writes1hShare = totals.cacheWrite5m + totals.cacheWrite1h > 0 ? totals.cacheWrite1h / (totals.cacheWrite5m + totals.cacheWrite1h) : null;

  return (
    <div className="page">
      {models.error && !rows ? null : (
        <div className="kpi-row">
          <KpiTile
            hero
            label="API-equivalent cost"
            value={rows ? fmtUsd(totals.costUsd) : '…'}
            sub={rows ? `${fmtTokens(totals.totalTokens)} tokens, ${fmtInt(totals.requests)} requests` : undefined}
            refreshing={models.refreshing}
          />
          <KpiTile label="Cache hit rate" value={rows ? fmtRatio(totals.cacheHitRate) : '…'} sub="cache read / all input" refreshing={models.refreshing} />
          <KpiTile label="Cache savings" value={rows ? fmtUsd(totals.cacheSavingsUsd) : '…'} sub="API-equivalent, vs no cache" refreshing={models.refreshing} />
          <KpiTile label="1-hour cache writes" value={rows ? fmtRatio(writes1hShare) : '…'} sub="share of cache-write tokens" refreshing={models.refreshing} />
        </div>
      )}

      {totals.unpriced.length > 0 && (
        <p className="notice notice-warning" role="note">
          No list price for {totals.unpriced.map(modelLabel).join(', ')}. Their tokens are counted but their cost shows as $0.
        </p>
      )}

      <Card
        title="Token mix"
        subtitle={mixMetric === 'cost' ? 'API-equivalent cost by token type' : 'Tokens by type'}
        refreshing={mixState.refreshing}
        actions={<Segmented<Metric> options={METRIC_OPTIONS} value={mixMetric} onChange={setMixMetric} label="Token mix metric" size="sm" />}
        footer={mixMetric === 'cost' ? <CostNote compact /> : undefined}
      >
        <AsyncView state={mixState} isEmpty={(d) => isAllZero(d.series)} empty={<EmptyState title="No usage in this range" />}>
          {(d) => <TokenMix data={d} metric={mixMetric} tz={tz} />}
        </AsyncView>
      </Card>

      <div className="mdl-grid">
        <Card title="Cache hit rate" subtitle="Cache read as a share of all input tokens" refreshing={typeTokens.refreshing}>
          <AsyncView state={typeTokens} isEmpty={(d) => isAllZero(d.series)} empty={<EmptyState title="No usage in this range" />}>
            {(d) => <HitRate data={d} />}
          </AsyncView>
        </Card>

        <Card title="Cache writes: 5-minute vs 1-hour" subtitle="Tokens written to the prompt cache, by TTL" refreshing={typeTokens.refreshing} footer={<CostNote compact />}>
          <AsyncView
            state={typeTokens}
            isEmpty={(d) => isAllZero(pickTypes(d.series, ['cacheWrite5m', 'cacheWrite1h']))}
            empty={<EmptyState title="No cache writes in this range" />}
          >
            {(d) => <CacheWrites data={d} cost={typeCost.data ? typeTotals(typeCost.data.series) : null} />}
          </AsyncView>
        </Card>
      </div>

      <Card
        title={modelMetric === 'cost' ? 'Cost by model' : 'Tokens by model'}
        subtitle={modelMetric === 'cost' ? `API-equivalent USD per ${bucket}` : `Tokens per ${bucket}`}
        refreshing={byModel.refreshing}
        actions={<Segmented<Metric> options={METRIC_OPTIONS} value={modelMetric} onChange={setModelMetric} label="Model chart metric" size="sm" />}
        footer={modelMetric === 'cost' ? <CostNote compact /> : undefined}
      >
        <AsyncView state={byModel} isEmpty={(d) => isAllZero(d.series)} empty={<EmptyState title="No usage in this range" />}>
          {(d) => (
            <StackedBarChart
              series={d.series}
              {...modelStyle}
              tz={tz}
              bucket={d.bucket}
              format={fmtFor(modelMetric)}
              axisFormat={modelMetric === 'cost' ? (v) => fmtUsd(v, { compact: true }) : undefined}
              costNote={modelMetric === 'cost'}
              ariaLabel={`${modelMetric === 'cost' ? 'API-equivalent cost' : 'Tokens'} by model per ${d.bucket}`}
            />
          )}
        </AsyncView>
      </Card>

      <Card title="Models" subtitle="Usage, cost and cache efficiency per model" refreshing={models.refreshing} footer={<CostNote />}>
        <AsyncView state={models} isEmpty={(d) => d.models.length === 0} empty={<EmptyState title="No models in this range" />}>
          {(d, refreshing) => (
            <DataTable
              columns={modelColumns(colors)}
              rows={d.models}
              rowKey={(m) => m.model}
              initialSort={{ key: 'cost', dir: 'desc' }}
              caption="Per-model usage. Costs are API-equivalent."
              refreshing={refreshing}
            />
          )}
        </AsyncView>
      </Card>
    </div>
  );
}

function TokenMix({ data, metric, tz }: { data: TimeseriesResponse; metric: Metric; tz: string }) {
  const totals = typeTotals(data.series);
  const parts = mixParts(totals);
  const fmt = fmtFor(metric);
  return (
    <>
      <MixBar parts={parts} label={metric === 'cost' ? 'API-equivalent cost by token type' : 'Tokens by type'} />
      <ul className="mdl-parts">
        {parts.map((p) => (
          <li key={p.type}>
            <span className="mdl-part-name">
              <TypeSwatch type={p.type} />
              {tokenTypeLabel(p.type)}
            </span>
            <span className="mdl-part-value">{fmt(p.value)}</span>
            <span className="mdl-part-share">{fmtRatio(p.share)}</span>
          </li>
        ))}
      </ul>
      <StackedBarChart
        series={orderByType(data.series)}
        {...typeStyle}
        tz={tz}
        bucket={data.bucket}
        format={fmt}
        axisFormat={metric === 'cost' ? (v) => fmtUsd(v, { compact: true }) : undefined}
        costNote={metric === 'cost'}
        height={220}
        ariaLabel={`${metric === 'cost' ? 'API-equivalent cost' : 'Tokens'} by token type per ${data.bucket}`}
      />
    </>
  );
}

function HitRate({ data }: { data: TimeseriesResponse }) {
  const points = hitRateSeries(data.series);
  const avg = hitRate(typeTotals(data.series));
  const stats = rateStats(points);
  const when = (t: number) => (data.bucket === 'day' ? fmtWeekdayDate(t, data.tz) : fmtDateTime(t, data.tz));
  return (
    <>
      <HitRateChart points={points} average={avg} tz={data.tz} bucket={data.bucket} />
      <dl className="mdl-stats">
        <div>
          <dt>Range average</dt>
          <dd>{fmtRatio(avg)}</dd>
        </div>
        <div>
          <dt>Best</dt>
          <dd>{stats.max ? `${fmtRatio(stats.max.rate)} (${when(stats.max.t)})` : '—'}</dd>
        </div>
        <div>
          <dt>Lowest</dt>
          <dd>{stats.min ? `${fmtRatio(stats.min.rate)} (${when(stats.min.t)})` : '—'}</dd>
        </div>
      </dl>
    </>
  );
}

function CacheWrites({ data, cost }: { data: TimeseriesResponse; cost: TypeTotals | null }) {
  const split = writeSplit(typeTotals(data.series), cost);
  const share5m = split.share1h == null ? null : 1 - split.share1h;
  return (
    <>
      <div className="mdl-split">
        <div className="mdl-split-cell">
          <span className="mdl-split-head">
            <TypeSwatch type="cacheWrite5m" />5-minute TTL
          </span>
          <span className="mdl-split-value">{fmtTokens(split.tokens5m)}</span>
          <span className="mdl-split-sub">
            {fmtRatio(share5m)} of writes{cost ? `, ${fmtUsd(split.cost5m)}` : ''}
          </span>
        </div>
        <div className="mdl-split-cell">
          <span className="mdl-split-head">
            <TypeSwatch type="cacheWrite1h" />1-hour TTL
          </span>
          <span className="mdl-split-value">{fmtTokens(split.tokens1h)}</span>
          <span className="mdl-split-sub">
            {fmtRatio(split.share1h)} of writes{cost ? `, ${fmtUsd(split.cost1h)}` : ''}
          </span>
        </div>
      </div>
      <StackedBarChart
        series={pickTypes(data.series, ['cacheWrite5m', 'cacheWrite1h'])}
        {...typeStyle}
        tz={data.tz}
        bucket={data.bucket}
        format={(v) => fmtTokens(v)}
        height={180}
        ariaLabel={`Cache-write tokens by TTL per ${data.bucket}`}
      />
      <p className="mdl-explain">
        1-hour writes cost 2x the input price, 5-minute writes 1.25x.
        {cost && split.tokens1h > 0 ? ` Writing the same 1-hour tokens at the 5-minute rate would have been ${fmtUsd(split.premium1h)} cheaper (API-equivalent), at the risk of more cache misses.` : ''}
      </p>
    </>
  );
}

function modelColumns(colors: Map<string, string>): Column<ModelRow>[] {
  return [
    {
      key: 'model',
      header: 'Model',
      sortValue: (m) => modelLabel(m.model),
      render: (m) => (
        <span className="cell-swatch">
          <span className="swatch" style={{ background: colors.get(m.model) ?? 'var(--series-other)' }} aria-hidden="true" />
          {modelLabel(m.model)}
          {!m.priced && <span className="tag">unpriced</span>}
        </span>
      ),
    },
    { key: 'cost', header: 'Cost', sortValue: (m) => m.costUsd, render: (m) => <span title="API-equivalent cost">{fmtUsd(m.costUsd)}</span>, numeric: true },
    {
      key: 'share',
      header: 'Share',
      sortValue: (m) => m.costShare,
      render: (m) => (
        <span className="mdl-share" title={`${fmtRatio(m.costShare)} of API-equivalent cost`}>
          <span className="mdl-share-track" aria-hidden="true">
            <span className="mdl-share-fill" style={{ width: `${Math.max(0, Math.min(1, m.costShare)) * 100}%` }} />
          </span>
          {fmtRatio(m.costShare)}
        </span>
      ),
      numeric: true,
    },
    { key: 'tokens', header: 'Tokens', sortValue: (m) => m.totalTokens, render: (m) => fmtTokens(m.totalTokens), numeric: true },
    {
      key: 'mix',
      header: 'Token mix',
      render: (m) => <MixBar size="sm" parts={mixParts(Object.fromEntries(TOKEN_TYPES.map((k) => [k, m[k]])) as TypeTotals)} label={`${modelLabel(m.model)} token mix`} />,
      hideOnMobile: true,
    },
    { key: 'cache', header: 'Cache hit', sortValue: (m) => m.cacheHitRate, render: (m) => fmtRatio(m.cacheHitRate), numeric: true, hideOnMobile: true },
    {
      key: 'saved',
      header: 'Cache saved',
      sortValue: (m) => m.cacheSavingsUsd,
      render: (m) => <span title="API-equivalent savings from cache reads">{fmtUsd(m.cacheSavingsUsd)}</span>,
      numeric: true,
      hideOnMobile: true,
    },
  ];
}
