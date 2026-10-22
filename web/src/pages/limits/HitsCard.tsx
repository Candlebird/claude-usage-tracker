import { useMemo } from 'react';
import type { LimitHit } from '@ccu/shared';
import { Card, DataTable, EmptyState, type Column } from '../../components';
import { fmtDateTime, fmtDuration } from '../../format';
import { hitRows, type HitRow } from './model';

export interface HitsCardProps {
  hits: readonly LimitHit[];
  windows: readonly { key: string; label: string }[];
  tz: string;
  refreshing: boolean;
}

export function HitsCard({ hits, windows, tz, refreshing }: HitsCardProps) {
  const rows = useMemo(() => hitRows(hits, windows), [hits, windows]);
  const cols: Column<HitRow>[] = [
    { key: 'ts', header: 'When', sortValue: (h) => h.ts, render: (h) => fmtDateTime(h.ts, tz), firstDir: 'desc' },
    { key: 'kind', header: 'Limit', sortValue: (h) => h.label, render: (h) => h.label },
    {
      key: 'reset',
      header: 'Resets',
      sortValue: (h) => h.resetsAt ?? null,
      render: (h) => (h.resetsAt != null ? fmtDateTime(h.resetsAt, tz) : '—'),
      hideOnMobile: true,
    },
    { key: 'lock', header: 'Locked out', sortValue: (h) => h.lockout, render: (h) => (h.lockout != null ? fmtDuration(h.lockout) : '—'), numeric: true, firstDir: 'desc' },
  ];
  return (
    <Card title="Limit hits" subtitle="Times a request was refused because a window was full" refreshing={refreshing}>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(h) => h.id}
        initialSort={{ key: 'ts', dir: 'desc' }}
        caption="Limit hits"
        refreshing={refreshing}
        empty={<EmptyState title="No limit hits in this range" icon="check">Nothing was refused for a full window.</EmptyState>}
      />
    </Card>
  );
}
