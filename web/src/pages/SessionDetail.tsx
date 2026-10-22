import { useMemo, useState } from 'react';
import type { KeyedTotals, SessionDetail as SessionDetailData } from '@ccu/shared';
import { AsyncView, Card, CostNote, DataTable, EmptyState, Icon, KpiTile, StackedBarChart, TabPanel, Tabs, isAllZero, type Column } from '../components';
import { agentKindLabel, fmtDateTime, fmtDuration, fmtInt, fmtRatio, fmtTokens, fmtUsd, modelLabel } from '../format';
import { ApiError } from '../api';
import { useApi } from '../hooks/useApi';
import { agentKindColor, modelColorMap } from '../palette';
import { href } from '../router';
import { useControls } from '../state/controls';
import { cacheHitRate, overheadView, tokenParts } from './sessions/derive';
import { ShareBar } from './sessions/ShareBar';
import { sessionTitle } from './sessions/sessionsQuery';
import './sessions/sessions.css';

type Split = 'model' | 'agent';
const TABS = [
  { value: 'model' as const, label: 'By model' },
  { value: 'agent' as const, label: 'By agent kind' },
];

const usd = (v: number) => fmtUsd(v);
const usdAxis = (v: number) => fmtUsd(v, { compact: true });

export default function SessionDetail({ id }: { id: string }) {
  const detail = useApi((c, signal) => c.session(id, { signal }), [id]);
  const notFound = detail.data === undefined && detail.error instanceof ApiError && detail.error.status === 404;

  return (
    <div className="page">
      <a className="back-link" href={href('/sessions')}>
        <Icon name="chevronLeft" size={14} /> All sessions
      </a>
      {notFound ? (
        <Card>
          <EmptyState title="Session not found" icon="list">
            It may be outside the synced history, or the link is wrong.
          </EmptyState>
        </Card>
      ) : (
        <AsyncView state={detail} skeletonHeight={360}>
          {(d, refreshing) => <SessionBody d={d} refreshing={refreshing} />}
        </AsyncView>
      )}
    </div>
  );
}

function SessionBody({ d, refreshing }: { d: SessionDetailData; refreshing: boolean }) {
  const { tz } = useControls();
  const [split, setSplit] = useState<Split>('model');
  const s = d.session;

  const modelColors = useMemo(() => modelColorMap([...d.byModel.map((m) => m.key), ...d.totals.byModel.map((m) => m.key)]), [d]);
  const style = useMemo(
    () =>
      split === 'model'
        ? { colorFor: (k: string) => modelColors.get(k) ?? 'var(--series-other)', labelFor: modelLabel }
        : { colorFor: agentKindColor, labelFor: agentKindLabel },
    [split, modelColors],
  );
  const series = split === 'model' ? d.byModel : d.byAgentKind;
  const rows = split === 'model' ? d.totals.byModel : d.totals.byAgentKind;
  const hit = cacheHitRate(d.totals.all);

  const totalsCols: Column<KeyedTotals>[] = [
    {
      key: 'key',
      header: split === 'model' ? 'Model' : 'Agent kind',
      sortValue: (r) => style.labelFor(r.key),
      render: (r) => (
        <span className="cell-swatch">
          <span className="swatch" style={{ background: style.colorFor(r.key) }} aria-hidden="true" />
          {style.labelFor(r.key)}
        </span>
      ),
    },
    { key: 'req', header: 'Requests', sortValue: (r) => r.requests, render: (r) => fmtInt(r.requests), numeric: true, hideOnMobile: true },
    { key: 'tok', header: 'Tokens', sortValue: (r) => r.totalTokens, render: (r) => fmtTokens(r.totalTokens), numeric: true },
    { key: 'cache', header: 'Cache hit', sortValue: (r) => cacheHitRate(r), render: (r) => fmtRatio(cacheHitRate(r)), numeric: true, hideOnMobile: true },
    { key: 'cost', header: 'Cost', sortValue: (r) => r.costUsd, render: (r) => fmtUsd(r.costUsd), numeric: true },
  ];

  return (
    <>
      <header className="sess-head">
        <h2>{sessionTitle(s)}</h2>
        <div className="sess-meta">
          <a href={href('/projects', { project: s.project })}>
            <Icon name="folder" size={14} /> {s.projectLabel}
          </a>
          {s.gitBranch && <span className="tag">{s.gitBranch}</span>}
          <span>
            {fmtDateTime(s.firstTs, tz)} to {fmtDateTime(s.lastTs, tz)}
          </span>
          <span className="mono small muted break" title="Session id">
            {s.sessionId}
          </span>
        </div>
      </header>

      <div className="kpi-row">
        <KpiTile hero label="API-equivalent cost" value={fmtUsd(s.costUsd)} sub={`${fmtInt(s.requests)} requests across ${s.models.length === 1 ? '1 model' : `${s.models.length} models`}`} refreshing={refreshing} />
        <KpiTile label="Tokens" value={fmtTokens(s.totalTokens)} sub={`Cache hit ${fmtRatio(hit)}`} refreshing={refreshing} />
        <KpiTile label="Duration" value={fmtDuration(s.durationSeconds)} sub="First to last request" refreshing={refreshing} />
        <KpiTile
          label="Agents"
          value={fmtInt(s.agentCount)}
          sub={s.linesAdded != null || s.linesRemoved != null ? `+${fmtInt(s.linesAdded ?? 0)} / −${fmtInt(s.linesRemoved ?? 0)} lines` : 'Main thread plus subagents'}
          refreshing={refreshing}
        />
      </div>

      <Card title="Timeline" subtitle="API-equivalent cost per hour" refreshing={refreshing} footer={<CostNote />}>
        <Tabs<Split> tabs={TABS} value={split} onChange={setSplit} label="Split cost by" idBase="session-split" />
        <TabPanel idBase="session-split" value={split}>
          {isAllZero(series) ? (
            <EmptyState title="No cost recorded in this session" />
          ) : (
            <StackedBarChart
              series={series}
              colorFor={style.colorFor}
              labelFor={style.labelFor}
              tz={tz}
              bucket="hour"
              format={usd}
              axisFormat={usdAxis}
              costNote
              height={240}
              ariaLabel={`Session cost per hour ${split === 'model' ? 'by model' : 'by agent kind'}`}
            />
          )}
          <DataTable columns={totalsCols} rows={rows} rowKey={(r) => r.key} initialSort={{ key: 'cost', dir: 'desc' }} caption={split === 'model' ? 'Totals by model' : 'Totals by agent kind'} />
        </TabPanel>
      </Card>

      <div className="sess-grid">
        <Card title="Model mix" subtitle="Share of API-equivalent cost" refreshing={refreshing}>
          <ShareBar
            label="Cost by model"
            format={usd}
            parts={d.totals.byModel.map((m) => ({ key: m.key, label: modelLabel(m.key), value: m.costUsd, color: modelColors.get(m.key) ?? 'var(--series-other)' }))}
          />
        </Card>
        <Card title="Main vs subagent vs workflow" subtitle="Share of API-equivalent cost" refreshing={refreshing}>
          <ShareBar
            label="Cost by agent kind"
            format={usd}
            parts={d.totals.byAgentKind.map((a) => ({ key: a.key, label: agentKindLabel(a.key), value: a.costUsd, color: agentKindColor(a.key) }))}
          />
        </Card>
        <Card title="Token mix" subtitle={`Cache hit rate ${fmtRatio(hit)}`} refreshing={refreshing}>
          <ShareBar label="Tokens by type" format={fmtTokens} parts={tokenParts(d.totals.all)} />
        </Card>
        <OverheadCard costUsd={s.costUsd} costStateUsd={s.costStateUsd} refreshing={refreshing} />
      </div>
    </>
  );
}

function OverheadCard({ costUsd, costStateUsd, refreshing }: { costUsd: number; costStateUsd: number | null; refreshing: boolean }) {
  const v = overheadView({ costUsd, costStateUsd });
  return (
    <Card title="Untracked overhead" subtitle="Cost the transcripts do not show" refreshing={refreshing} footer={<CostNote compact />}>
      {v.kind === 'missing' ? (
        <p className="muted small">
          This session has no cost-state record, so there is nothing to compare the transcript total of {fmtUsd(v.transcriptUsd)} against. Claude Code writes one when a session ends normally.
        </p>
      ) : (
        <>
          <dl className="overhead">
            <div>
              <dt>From transcripts</dt>
              <dd>{fmtUsd(v.transcriptUsd)}</dd>
            </div>
            <div>
              <dt>Cost-state total</dt>
              <dd>{fmtUsd(v.costStateUsd)}</dd>
            </div>
            <div>
              <dt>Difference</dt>
              <dd>
                {v.diffUsd > 0 ? '+' : v.diffUsd < 0 ? '−' : ''}
                {fmtUsd(Math.abs(v.diffUsd))}
              </dd>
            </div>
          </dl>
          <p className="muted small">
            {v.kind === 'extra' &&
              `${fmtRatio(v.share)} of this session's cost-state total came from work outside the transcripts: title generation, classifiers and compaction.`}
            {v.kind === 'none' && 'The transcripts account for the whole cost-state total.'}
            {v.kind === 'under' &&
              'The cost-state total is lower than the transcripts. That usually means it was written before the session finished, or the session was resumed afterwards.'}
          </p>
        </>
      )}
    </Card>
  );
}
