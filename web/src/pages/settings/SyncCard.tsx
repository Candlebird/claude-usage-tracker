import type { StatusResponse, SyncRun } from '@ccu/shared';
import { AsyncView, Card, DataTable, EmptyState, Icon, type Column } from '../../components';
import { fmtDateTime, fmtInt, fmtRelative, fmtTime } from '../../format';
import type { ApiState } from '../../hooks/useApi';
import { HealthBadge } from './HealthBadge';
import { latestErrors, syncHealth, syncRunsWithin } from './logic';

function runColumns(tz: string): Column<SyncRun>[] {
  return [
    { key: 'ts', header: 'Time', sortValue: (r) => r.ts, firstDir: 'desc', render: (r) => <span title={fmtDateTime(r.ts, tz)}>{fmtTime(r.ts, tz)}</span> },
    { key: 'device', header: 'Device', hideOnMobile: true, sortValue: (r) => r.device ?? '', render: (r) => r.device || '—' },
    { key: 'rows', header: 'Rows', numeric: true, sortValue: (r) => r.rows, render: (r) => fmtInt(r.rows) },
    { key: 'pending', header: 'Pending', numeric: true, sortValue: (r) => r.pending, render: (r) => fmtInt(r.pending) },
    {
      key: 'errors',
      header: 'Errors',
      numeric: true,
      sortValue: (r) => r.errors.length,
      render: (r) =>
        r.errors.length > 0 ? (
          <span className="status-badge status-critical" title={r.errors.join('\n')}>
            <Icon name="alert" size={13} /> {r.errors.length}
          </span>
        ) : (
          <span className="muted">0</span>
        ),
    },
  ];
}

export function SyncCard({ state, now, tz, staleMinutes }: { state: ApiState<StatusResponse>; now: number; tz: string; staleMinutes: number }) {
  return (
    <Card id="settings-sync" title="Sync" subtitle="ccu sync uploads changed hourly buckets every 5 minutes" refreshing={state.refreshing}>
      <AsyncView state={state} skeletonHeight={180}>
        {(st) => {
          const runs = st.syncRuns;
          const last = runs[0];
          const errs = latestErrors(runs);
          if (!last) {
            return (
              <EmptyState title="No sync runs yet" icon="refresh">
                Run <code>ccu install</code> on your PC, then <code>ccu sync</code>. Runs show up here within 5 minutes.
              </EmptyState>
            );
          }
          return (
            <>
              <div className="settings-row">
                <HealthBadge health={syncHealth(last.ts, now, staleMinutes)} />
                <span className="muted small">Alerts after {staleMinutes} min without a sync</span>
              </div>
              <dl className="kv">
                <dt>Last sync</dt>
                <dd>
                  {fmtRelative(last.ts, now)} <span className="muted">· {fmtDateTime(last.ts, tz)}</span>
                </dd>
                <dt>Device</dt>
                <dd>{last.device || '—'}</dd>
                <dt>Sync version</dt>
                <dd className="mono">{last.version ?? '—'}</dd>
                <dt>Runs, last hour</dt>
                <dd>{fmtInt(syncRunsWithin(runs, now, 3600))} of 12 expected</dd>
                <dt>Rows pending</dt>
                <dd>{(last.pending ?? 0) > 0 ? `${fmtInt(last.pending)} (backfill continues next run)` : 'None'}</dd>
              </dl>
              {errs && (
                <div className="notice notice-error" role="status">
                  <p className="settings-notice-title">
                    <Icon name="alert" size={14} /> Errors from the run {fmtRelative(errs.ts, now)}
                  </p>
                  <ul className="settings-list">
                    {errs.errors.map((e) => (
                      <li key={e} className="mono break">
                        {e}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <DataTable
                caption="Recent sync runs"
                columns={runColumns(tz)}
                rows={runs}
                rowKey={(r) => `${r.ts}:${r.device ?? ''}`}
                initialSort={{ key: 'ts', dir: 'desc' }}
                refreshing={state.refreshing}
              />
            </>
          );
        }}
      </AsyncView>
    </Card>
  );
}
