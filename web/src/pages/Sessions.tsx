import { useMemo, useState } from 'react';
import type { SessionRow, SessionSort } from '@ccu/shared';
import { AsyncView, Card, CostNote, DataTable, EmptyState, Segmented, type Column } from '../components';
import { fmtDateTime, fmtDuration, fmtInt, fmtTokens, fmtUsd, modelLabel } from '../format';
import { useApi } from '../hooks/useApi';
import { modelColorMap } from '../palette';
import { navigate, parseHash, setQuery, type Route } from '../router';
import { useControls } from '../state/controls';
import { Pagination } from './sessions/Pagination';
import { matchesSession, PAGE_SIZE, readSessionsQuery, sessionTitle } from './sessions/sessionsQuery';
import './sessions/sessions.css';

const SORTS = [
  { value: 'recent' as const, label: 'Recent' },
  { value: 'cost' as const, label: 'Top cost' },
];

export default function Sessions({ route }: { route?: Route }) {
  const { range, tz } = useControls();
  const q = readSessionsQuery((route ?? parseHash(window.location.hash)).query);
  const [needle, setNeedle] = useState('');

  const projects = useApi((c, signal) => c.projects({ ...range, tz }, { signal }), [range.from, range.to, tz]);
  const sessions = useApi(
    (c, signal) => c.sessions({ ...range, project: q.project ?? undefined, sort: q.sort, limit: PAGE_SIZE, offset: (q.page - 1) * PAGE_SIZE }, { signal }),
    [range.from, range.to, q.project, q.sort, q.page],
  );

  const projectOptions = useMemo(() => {
    const opts = (projects.data?.projects ?? []).map((p) => ({ value: p.project, label: p.label })).sort((a, b) => a.label.localeCompare(b.label));
    if (q.project && !opts.some((o) => o.value === q.project)) opts.unshift({ value: q.project, label: q.project });
    return opts;
  }, [projects.data, q.project]);

  const pageRows = sessions.data?.sessions;
  const colors = useMemo(() => modelColorMap((pageRows ?? []).flatMap((s) => s.models)), [pageRows]);
  const visible = useMemo(() => (pageRows ?? []).filter((s) => matchesSession(s, needle, modelLabel)), [pageRows, needle]);

  const cols: Column<SessionRow>[] = [
    {
      key: 'title',
      header: 'Session',
      sortValue: (s) => sessionTitle(s).toLowerCase(),
      render: (s) => (
        <div className="cell-stack">
          <span className="cell-strong sess-title">{sessionTitle(s)}</span>
          <span className="sess-sub">
            {s.projectLabel}
            {s.gitBranch ? ` · ${s.gitBranch}` : ''}
            <span className="show-sm-inline"> · {fmtDateTime(s.firstTs, tz)}</span>
          </span>
        </div>
      ),
    },
    { key: 'start', header: 'Started', sortValue: (s) => s.firstTs, render: (s) => fmtDateTime(s.firstTs, tz), hideOnMobile: true, firstDir: 'desc' },
    { key: 'dur', header: 'Duration', sortValue: (s) => s.durationSeconds, render: (s) => fmtDuration(s.durationSeconds), numeric: true, hideOnMobile: true, firstDir: 'desc' },
    {
      key: 'models',
      header: 'Models',
      render: (s) => (
        <span className="sess-models">
          {s.models.map((m) => (
            <span key={m}>
              <span className="swatch" style={{ background: colors.get(m) }} aria-hidden="true" />
              {modelLabel(m)}
            </span>
          ))}
        </span>
      ),
      hideOnMobile: true,
    },
    { key: 'agents', header: 'Agents', sortValue: (s) => s.agentCount, render: (s) => fmtInt(s.agentCount), numeric: true, hideOnMobile: true, firstDir: 'desc' },
    { key: 'tokens', header: 'Tokens', sortValue: (s) => s.totalTokens, render: (s) => fmtTokens(s.totalTokens), numeric: true, hideOnMobile: true, firstDir: 'desc' },
    { key: 'cost', header: 'Cost', sortValue: (s) => s.costUsd, render: (s) => <span className="cell-strong">{fmtUsd(s.costUsd)}</span>, numeric: true, firstDir: 'desc' },
    {
      key: 'overhead',
      header: 'Untracked',
      sortValue: (s) => s.untrackedOverheadUsd,
      render: (s) => <span className="muted">{fmtUsd(s.untrackedOverheadUsd)}</span>,
      numeric: true,
      hideOnMobile: true,
      firstDir: 'desc',
    },
  ];

  const setSort = (v: SessionSort) => setQuery({ sort: v === 'recent' ? null : v, page: null });

  return (
    <div className="page">
      <Card
        title="Sessions"
        subtitle={q.sort === 'cost' ? 'Most expensive first, API-equivalent cost' : 'Most recent first, API-equivalent cost'}
        refreshing={sessions.refreshing}
        footer={<CostNote />}
      >
        <div className="sess-filters">
          <label className="field">
            <span className="field-label">Project</span>
            <select value={q.project ?? ''} onChange={(e) => setQuery({ project: e.target.value || null, page: null })}>
              <option value="">All projects</option>
              {projectOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Filter this page</span>
            <input type="search" value={needle} placeholder="Title, branch, model" onChange={(e) => setNeedle(e.target.value)} />
          </label>
          <div className="sess-filter-sort">
            <Segmented<SessionSort> label="Order sessions by" options={SORTS} value={q.sort} onChange={setSort} size="sm" />
          </div>
        </div>
        <AsyncView
          state={sessions}
          skeletonHeight={320}
          isEmpty={(d) => d.total === 0}
          empty={
            <EmptyState
              title={q.project ? 'No sessions for this project in this range' : 'No sessions in this range'}
              action={
                q.project ? (
                  <button type="button" className="btn btn-sm" onClick={() => setQuery({ project: null, page: null })}>
                    Show all projects
                  </button>
                ) : undefined
              }
            >
              Try a longer date range.
            </EmptyState>
          }
        >
          {(d, refreshing) => (
            <>
              <DataTable
                key={`${q.sort}|${q.page}`}
                columns={cols}
                rows={visible}
                rowKey={(s) => s.sessionId}
                onRowClick={(s) => navigate(`/sessions/${encodeURIComponent(s.sessionId)}`)}
                caption={`Sessions, page ${q.page}`}
                refreshing={refreshing}
                empty={<EmptyState title="No session on this page matches the filter" icon="list" />}
              />
              <Pagination total={d.total} page={q.page} size={PAGE_SIZE} visible={visible.length} onPage={(p) => setQuery({ page: p > 1 ? p : null })} />
            </>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
