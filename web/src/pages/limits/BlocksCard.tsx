import { useMemo } from 'react';
import type { FiveHourBlock } from '@ccu/shared';
import { Card, CostNote, DataTable, EmptyState, Meter, type Column } from '../../components';
import { fmtDateTime, fmtDuration, fmtInt, fmtPct, fmtTokens, fmtUsd } from '../../format';
import { summarizeBlocks, type Thresholds } from './model';

export interface BlocksCardProps {
  blocks: readonly FiveHourBlock[];
  thresholds: Thresholds;
  tz: string;
  refreshing: boolean;
}

export function BlocksCard({ blocks, thresholds, tz, refreshing }: BlocksCardProps) {
  const s = useMemo(() => summarizeBlocks(blocks), [blocks]);

  const cols: Column<FiveHourBlock>[] = [
    {
      key: 'start',
      header: 'Started',
      sortValue: (b) => b.start,
      firstDir: 'desc',
      render: (b) => (
        <>
          {fmtDateTime(b.start, tz)}
          {b.active && <span className="tag">Active</span>}
        </>
      ),
    },
    {
      key: 'len',
      header: 'Length',
      sortValue: (b) => b.end - b.start,
      render: (b) => fmtDuration(b.end - b.start),
      numeric: true,
      hideOnMobile: true,
    },
    {
      key: 'peak',
      header: 'Peak',
      sortValue: (b) => b.peakUtilization,
      firstDir: 'desc',
      render: (b) => (
        <span className="lim-peak">
          <span className="lim-peak-meter">
            <Meter value={b.peakUtilization} label={`Peak ${fmtPct(b.peakUtilization, 0)}`} thresholds={thresholds} size="sm" />
          </span>
          {fmtPct(b.peakUtilization, 0)}
        </span>
      ),
      numeric: true,
    },
    { key: 'cost', header: 'Cost (API-eq.)', sortValue: (b) => b.costUsd, render: (b) => fmtUsd(b.costUsd), numeric: true, firstDir: 'desc' },
    { key: 'tokens', header: 'Tokens', sortValue: (b) => b.tokens, render: (b) => fmtTokens(b.tokens), numeric: true, hideOnMobile: true, firstDir: 'desc' },
    {
      key: 'cpp',
      header: '$ per 1%',
      sortValue: (b) => b.costPerPercent,
      render: (b) => (b.costPerPercent == null ? '—' : fmtUsd(b.costPerPercent)),
      numeric: true,
      firstDir: 'desc',
    },
  ];

  return (
    <Card
      title="5-hour blocks"
      subtitle="Each session window: how full it got and what it cost at API prices"
      refreshing={refreshing}
      footer={<CostNote />}
    >
      {blocks.length > 0 && (
        <dl className="lim-strip">
          <div>
            <dt>Blocks</dt>
            <dd>{fmtInt(s.count)}</dd>
          </div>
          <div>
            <dt>Avg peak</dt>
            <dd>{fmtPct(s.avgPeak, 0)}</dd>
          </div>
          <div>
            <dt>Hit 100%</dt>
            <dd>{fmtInt(s.maxedOut)}</dd>
          </div>
          <div title={s.medianCostPerPercent != null ? `Median ${fmtUsd(s.medianCostPerPercent)} per 1% x 100` : undefined}>
            <dt>Est. block capacity</dt>
            <dd>
              {s.capacityUsd == null ? '—' : `≈ ${fmtUsd(s.capacityUsd)}`}
              <span className="lim-strip-note">
                {s.capacityUsd == null ? 'needs blocks above 10%' : `API-equivalent, median of ${s.sampleSize}`}
              </span>
            </dd>
          </div>
        </dl>
      )}
      <DataTable
        columns={cols}
        rows={blocks}
        rowKey={(b) => String(b.start)}
        initialSort={{ key: 'start', dir: 'desc' }}
        caption="Five-hour blocks"
        refreshing={refreshing}
        empty={<EmptyState title="No 5-hour blocks in this range">A block starts with the first message after the previous one resets.</EmptyState>}
      />
    </Card>
  );
}
