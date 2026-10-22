import type { SummaryResponse } from '@ccu/shared';
import { Card, EmptyState, LimitGauge } from '../../components';
import { fmtRelative } from '../../format';
import { href } from '../../router';
import { sortLimitWindows } from './model';

/** Stale beyond two missed 5-minute sync runs. */
const STALE_SECONDS = 15 * 60;

export function PlanLimits({ s, now, tz, refreshing }: { s: SummaryResponse; now: number; tz: string; refreshing: boolean }) {
  const windows = sortLimitWindows(s.limits);
  const stale = s.sync.lastSyncTs != null && now - s.sync.lastSyncTs > STALE_SECONDS;
  const synced = s.sync.lastSyncTs == null ? 'Not synced yet' : `Synced ${fmtRelative(s.sync.lastSyncTs, now)}`;
  return (
    <Card
      title="Plan limits"
      subtitle={
        <>
          {synced}
          {stale && <span className="ov-stale"> (stale)</span>}
        </>
      }
      actions={
        <a className="btn btn-sm btn-ghost" href={href('/limits')}>
          Details
        </a>
      }
      refreshing={refreshing}
    >
      {windows.length === 0 ? (
        <EmptyState title="No limit data yet" icon="gauge">
          The sync client reports plan limits after its first run.
        </EmptyState>
      ) : (
        <div className="gauge-grid">
          {windows.map((w) => (
            <LimitGauge key={w.key} window={w} now={now} tz={tz} />
          ))}
        </div>
      )}
    </Card>
  );
}
