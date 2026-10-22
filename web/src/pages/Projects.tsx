import { useCallback, useMemo, useState } from 'react';
import type { ProjectRow } from '@ccu/shared';
import { AsyncView, Card, CostNote, DataTable, Drawer, EmptyState, KpiTile, Segmented, Sparkline, StackedBarChart, isAllZero, type Column } from '../components';
import { fmtInt, fmtRatio, fmtRelative, fmtTokens, fmtUsd, modelLabel } from '../format';
import { useApi } from '../hooks/useApi';
import { OTHER_COLOR } from '../palette';
import { setQuery, useRoute } from '../router';
import { useControls } from '../state/controls';
import { ProjectDrawerBody } from './projects/ProjectDrawer';
import { foldUncolored, projectColorMap } from './projects/projectColors';
import { cacheHitRate, sumCacheFields } from './sessions/derive';
import './projects/projects.css';
import './sessions/sessions.css';

type Metric = 'cost' | 'tokens';
const METRICS = [
  { value: 'cost' as const, label: 'Cost' },
  { value: 'tokens' as const, label: 'Tokens' },
];

export default function Projects() {
  const { range, bucket, tz, now } = useControls();
  const route = useRoute();
  const open = route.query.get('project');
  const [metric, setMetric] = useState<Metric>('cost');
  const [needle, setNeedle] = useState('');

  const projects = useApi((c, signal) => c.projects({ ...range, tz }, { signal }), [range.from, range.to, tz]);
  const series = useApi(
    (c, signal) => c.timeseries({ ...range, bucket, group: 'project', metric, tz }, { signal }),
    [range.from, range.to, bucket, tz, metric],
  );

  const rows = projects.data?.projects;
  const colors = useMemo(() => projectColorMap(rows ?? []), [rows]);
  const byKey = useMemo(() => new Map((rows ?? []).map((p) => [p.project, p])), [rows]);
  const totals = useMemo(() => summarize(rows ?? []), [rows]);
  const chartSeries = useMemo(() => foldUncolored(series.data?.series ?? [], colors), [series.data, colors]);
  const visible = useMemo(() => {
    const n = needle.trim().toLowerCase();
    return n ? (rows ?? []).filter((p) => `${p.label}\n${p.path}\n${p.project}`.toLowerCase().includes(n)) : (rows ?? []);
  }, [rows, needle]);

  const colorOf = (k: string) => colors.get(k) ?? OTHER_COLOR;
  const labelOf = (k: string) => byKey.get(k)?.label ?? series.data?.series.find((s) => s.key === k)?.label ?? k;

  const cols: Column<ProjectRow>[] = [
    {
      key: 'label',
      header: 'Project',
      sortValue: (p) => p.label.toLowerCase(),
      render: (p) => (
        <span className="cell-swatch">
          <span className="swatch" style={{ background: colorOf(p.project) }} aria-hidden="true" />
          <span className="cell-stack">
            <span className="cell-strong">{p.label}</span>
            <span className="proj-sub show-sm-inline">{fmtRelative(p.lastActive, now)}</span>
          </span>
        </span>
      ),
    },
    { key: 'cost', header: 'Cost', sortValue: (p) => p.costUsd, render: (p) => <span className="cell-strong">{fmtUsd(p.costUsd)}</span>, numeric: true, firstDir: 'desc' },
    {
      key: 'share',
      header: 'Share',
      sortValue: (p) => p.costUsd,
      render: (p) => {
        const share = totals.costUsd > 0 ? p.costUsd / totals.costUsd : 0;
        return (
          <span className="proj-share" title={`${fmtRatio(share)} of API-equivalent cost`}>
            <span className="proj-share-track" aria-hidden="true">
              <span style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%`, background: colorOf(p.project) }} />
            </span>
            <span className="proj-share-pct">{fmtRatio(share)}</span>
          </span>
        );
      },
      numeric: true,
      hideOnMobile: true,
      firstDir: 'desc',
    },
    {
      key: 'trend',
      header: 'Daily cost',
      render: (p) => <Sparkline values={p.sparkline.map((d) => d.costUsd)} width={88} height={22} color={colorOf(p.project)} label={`${p.label} daily cost`} />,
      hideOnMobile: true,
    },
    { key: 'tokens', header: 'Tokens', sortValue: (p) => p.totalTokens, render: (p) => fmtTokens(p.totalTokens), numeric: true, hideOnMobile: true, firstDir: 'desc' },
    { key: 'sessions', header: 'Sessions', sortValue: (p) => p.sessions, render: (p) => fmtInt(p.sessions), numeric: true, firstDir: 'desc' },
    { key: 'cache', header: 'Cache hit', sortValue: (p) => p.cacheHitRate, render: (p) => fmtRatio(p.cacheHitRate), numeric: true, hideOnMobile: true, firstDir: 'desc' },
    { key: 'model', header: 'Top model', sortValue: (p) => modelLabel(p.topModel), render: (p) => modelLabel(p.topModel), hideOnMobile: true },
    { key: 'last', header: 'Last active', sortValue: (p) => p.lastActive, render: (p) => fmtRelative(p.lastActive, now), numeric: true, hideOnMobile: true, firstDir: 'desc' },
  ];

  const openRow = open ? byKey.get(open) : undefined;
  const close = useCallback(() => setQuery({ project: null }), []);

  return (
    <div className="page">
      <AsyncView state={projects} skeletonHeight={112}>
        {(d, refreshing) => (
          <div className="kpi-row">
            <KpiTile
              hero
              label="API-equivalent cost"
              value={fmtUsd(totals.costUsd)}
              sub={`${fmtInt(d.projects.length)} ${d.projects.length === 1 ? 'project' : 'projects'} active in this range`}
              refreshing={refreshing}
            />
            <KpiTile label="Tokens" value={fmtTokens(totals.totalTokens)} sub={`${fmtInt(totals.requests)} requests`} refreshing={refreshing} />
            <KpiTile label="Sessions" value={fmtInt(totals.sessions)} sub={top(d.projects)} refreshing={refreshing} />
            <KpiTile label="Cache hit rate" value={fmtRatio(totals.cacheHitRate)} sub="Cache reads over all prompt tokens" refreshing={refreshing} />
          </div>
        )}
      </AsyncView>

      <Card
        title={metric === 'cost' ? 'Cost by project' : 'Tokens by project'}
        subtitle={`Per ${bucket}${metric === 'cost' ? ', API-equivalent' : ''}`}
        actions={<Segmented<Metric> label="Chart metric" options={METRICS} value={metric} onChange={setMetric} size="sm" />}
        refreshing={series.refreshing}
        footer={metric === 'cost' ? <CostNote /> : undefined}
      >
        <AsyncView state={series} skeletonHeight={260} isEmpty={(d) => isAllZero(d.series)} empty={<EmptyState title="No usage in this range" />}>
          {() => (
            <StackedBarChart
              series={chartSeries}
              colorFor={colorOf}
              labelFor={labelOf}
              tz={tz}
              bucket={bucket}
              format={metric === 'cost' ? (v) => fmtUsd(v) : fmtTokens}
              axisFormat={metric === 'cost' ? (v) => fmtUsd(v, { compact: true }) : fmtTokens}
              costNote={metric === 'cost'}
              height={260}
              ariaLabel={`${metric === 'cost' ? 'API-equivalent cost' : 'Tokens'} per ${bucket} by project. The table below lists the totals.`}
            />
          )}
        </AsyncView>
      </Card>

      <Card title="All projects" subtitle="Select a project for its breakdown and sessions" refreshing={projects.refreshing} footer={<CostNote />}>
        <div className="sess-filters">
          <label className="field">
            <span className="field-label">Find a project</span>
            <input type="search" value={needle} placeholder="Name or path" onChange={(e) => setNeedle(e.target.value)} />
          </label>
        </div>
        <AsyncView
          state={projects}
          skeletonHeight={280}
          isEmpty={(d) => d.projects.length === 0}
          empty={<EmptyState title="No projects in this range">Try a longer date range, or check that sync is running.</EmptyState>}
        >
          {(_, refreshing) => (
            <DataTable
              columns={cols}
              rows={visible}
              rowKey={(p) => p.project}
              initialSort={{ key: 'cost', dir: 'desc' }}
              onRowClick={(p) => setQuery({ project: p.project })}
              caption="Projects in the selected range"
              refreshing={refreshing}
              empty={<EmptyState title="No project matches" icon="folder" />}
            />
          )}
        </AsyncView>
      </Card>
      <p className="muted small">Times in {tz}.</p>

      <Drawer open={!!open} onClose={close} title={openRow?.label ?? open ?? 'Project'} width={560}>
        {open && <ProjectDrawerBody key={open} project={open} row={openRow} color={colorOf(open)} />}
      </Drawer>
    </div>
  );
}

function summarize(rows: readonly ProjectRow[]) {
  const sum = (f: (p: ProjectRow) => number) => rows.reduce((n, p) => n + f(p), 0);
  return {
    costUsd: sum((p) => p.costUsd),
    totalTokens: sum((p) => p.totalTokens),
    requests: sum((p) => p.requests),
    sessions: sum((p) => p.sessions),
    cacheHitRate: cacheHitRate(sumCacheFields(rows)),
  };
}

function top(rows: readonly ProjectRow[]): string | undefined {
  const best = rows.reduce<ProjectRow | undefined>((a, p) => (!a || p.costUsd > a.costUsd ? p : a), undefined);
  return best && best.costUsd > 0 ? `Most cost: ${best.label}` : undefined;
}
