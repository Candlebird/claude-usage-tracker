import type { StatusResponse } from '@ccu/shared';
import { AsyncView, Card, DataTable, Meter, type Column } from '../../components';
import { fmtCompact, fmtCountdown, fmtInt, fmtPct } from '../../format';
import type { ApiState } from '../../hooks/useApi';
import { HealthBadge } from './HealthBadge';
import { quotaUsage, secondsToUtcMidnight, toTableRows, type TableRow } from './logic';

const COLUMNS: Column<TableRow>[] = [
  { key: 'table', header: 'Table', sortValue: (r) => r.table, render: (r) => <span className="mono">{r.table}</span> },
  { key: 'rows', header: 'Rows', numeric: true, sortValue: (r) => r.rows, render: (r) => fmtInt(r.rows) },
  { key: 'share', header: 'Share', numeric: true, hideOnMobile: true, sortValue: (r) => r.share, render: (r) => fmtPct(r.share * 100, 0) },
];

export function StorageCard({ state, now }: { state: ApiState<StatusResponse>; now: number }) {
  return (
    <Card id="settings-storage" title="Cloudflare free tier" subtitle="D1 usage against the daily free quota" refreshing={state.refreshing}>
      <AsyncView state={state} skeletonHeight={160}>
        {(st) => {
          const q = quotaUsage(st.d1RowsWrittenToday, st.freeTier.rowsWrittenPerDay);
          const rows = toTableRows(st.tableRows);
          const total = rows.reduce((a, r) => a + r.rows, 0);
          return (
            <>
              <div className="quota">
                <div className="quota-head">
                  <span className="quota-label">Rows written today</span>
                  <HealthBadge health={q.health} />
                </div>
                <div className="quota-value">
                  {fmtInt(q.used)} <span className="muted">/ {fmtCompact(q.limit)}</span>
                  <span className="quota-pct">{fmtPct(q.pct, q.pct < 10 ? 1 : 0)}</span>
                </div>
                <Meter value={q.pct} label="D1 rows written today, share of the free daily quota" />
                <p className="muted small">Approximate. Resets at 00:00 UTC, in {fmtCountdown(now + secondsToUtcMidnight(now), now)}.</p>
              </div>
              <dl className="kv">
                <dt>Rows read / day</dt>
                <dd>{fmtCompact(st.freeTier.rowsReadPerDay)} free</dd>
                <dt>Worker requests / day</dt>
                <dd>{fmtCompact(st.freeTier.requestsPerDay)} free</dd>
                <dt>Rows stored</dt>
                <dd>{fmtInt(total)} across {rows.length} tables</dd>
              </dl>
              <DataTable caption="Approximate rows per D1 table" columns={COLUMNS} rows={rows} rowKey={(r) => r.table} initialSort={{ key: 'rows', dir: 'desc' }} />
            </>
          );
        }}
      </AsyncView>
    </Card>
  );
}
