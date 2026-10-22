import type { ReactNode } from 'react';
import type { Settings, StatusResponse } from '@ccu/shared';
import { ErrorState, Meter, Skeleton } from '../../components';
import { fmtCompact, fmtPct, fmtRelative } from '../../format';
import type { ApiState } from '../../hooks/useApi';
import { HealthBadge } from './HealthBadge';
import { dataQualityHealth, liveHealth, quotaUsage, syncHealth, type Health } from './logic';

interface TileProps {
  label: string;
  health: Health;
  value: string;
  sub: string;
  /** id of the card this tile summarizes. */
  target: string;
  children?: ReactNode;
}

function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

// A button, not a link: the hash belongs to the router.
function Tile({ label, health, value, sub, target, children }: TileProps) {
  return (
    <button type="button" className="health-tile" onClick={() => jumpTo(target)} aria-label={`${label}: ${health.label}, ${value}. Show details`}>
      <span className="health-tile-head">
        <span className="kpi-label">{label}</span>
        <HealthBadge health={health} />
      </span>
      <span className="health-tile-value">{value}</span>
      {children}
      <span className="health-tile-sub">{sub}</span>
    </button>
  );
}

function qualitySub(st: StatusResponse): string {
  if (st.unpricedModels.length > 0) return 'Some cost shows as $0';
  if (st.outputIncomplete.requests > 0) return `${fmtCompact(st.outputIncomplete.requests)} requests missing final output`;
  return 'All models priced';
}

/** At-a-glance health: sync, live data, D1 quota, data quality. Each tile jumps to its card. */
export function HealthStrip({ status, settings, now }: { status: ApiState<StatusResponse>; settings: Settings | undefined; now: number }) {
  if (status.loading) {
    return (
      <div className="health-strip" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="health-tile">
            <Skeleton lines={3} height={14} />
          </div>
        ))}
      </div>
    );
  }
  if (!status.data) return <ErrorState error={status.error ?? 'No status'} onRetry={status.reload} title="Could not load health" />;

  const st = status.data;
  const stale = settings?.staleSyncMinutes ?? 60;
  const lastSync = st.syncRuns[0]?.ts ?? null;
  const quota = quotaUsage(st.d1RowsWrittenToday, st.freeTier.rowsWrittenPerDay);
  const pending = st.syncRuns[0]?.pending ?? 0;
  const issues = st.unpricedModels.length + (st.outputIncomplete.requests > 0 ? 1 : 0);

  return (
    <div className={`health-strip${status.refreshing ? ' is-refreshing' : ''}`} role="list" aria-label="System health">
      <div role="listitem">
        <Tile
          label="Sync"
          health={syncHealth(lastSync, now, stale)}
          value={fmtRelative(lastSync, now)}
          sub={pending > 0 ? `${fmtCompact(pending)} rows still to upload` : 'Nothing pending'}
          target="settings-sync"
        />
      </div>
      <div role="listitem">
        <Tile
          label="Live data (OTel)"
          health={liveHealth(st.otelLastReceivedTs, now)}
          value={fmtRelative(st.otelLastReceivedTs, now)}
          sub="Last api_request event"
          target="settings-quality"
        />
      </div>
      <div role="listitem">
        <Tile label="D1 writes today" health={quota.health} value={fmtPct(quota.pct, quota.pct < 10 ? 1 : 0)} sub={`${fmtCompact(quota.used)} of ${fmtCompact(quota.limit)} free rows`} target="settings-storage">
          <Meter value={quota.pct} label="D1 rows written today, share of free quota" size="sm" />
        </Tile>
      </div>
      <div role="listitem">
        <Tile
          label="Data quality"
          health={dataQualityHealth(st)}
          value={issues === 0 ? 'No issues' : `${issues} note${issues === 1 ? '' : 's'}`}
          sub={qualitySub(st)}
          target="settings-quality"
        />
      </div>
    </div>
  );
}
