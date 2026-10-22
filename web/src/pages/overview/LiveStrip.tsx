import type { LiveResponse } from '@ccu/shared';
import { AsyncView, Card, CostNote, EmptyState } from '../../components';
import { fmtCompact, fmtInt, fmtMs, fmtRelative, fmtTime, fmtUsd, modelLabel } from '../../format';
import { useApi } from '../../hooks/useApi';
import { useControls } from '../../state/controls';
import { barHeightPct, liveTotals } from './model';

const MINUTES = 60;
const RECENT_ROWS = 5;

function isQuiet(d: LiveResponse): boolean {
  return d.lastReceivedTs == null && d.perMinute.every((p) => p.requests === 0);
}

/** One bar per minute; the figures beside it carry the values, the title tooltip only adds detail. */
function MinuteBars({ d, tz }: { d: LiveResponse; tz: string }) {
  const peak = Math.max(0, ...d.perMinute.map((p) => p.costUsd));
  return (
    <div className="ov-live-plot">
      <div className="ov-live-bars" role="img" aria-label={`API-equivalent cost per minute over the last ${d.minutes} minutes`}>
        {d.perMinute.map((p) => {
          const h = barHeightPct(p.costUsd, peak);
          return (
            <div key={p.t} className="ov-live-slot" title={`${fmtTime(p.t, tz)}: ${fmtUsd(p.costUsd)}, ${fmtInt(p.requests)} requests, ${fmtCompact(p.tokens)} tokens`}>
              {h > 0 && <div className="ov-live-bar" style={{ height: `${h}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="ov-live-axis muted small" aria-hidden="true">
        <span>{d.minutes} min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

function LiveBody({ d, tz, now }: { d: LiveResponse; tz: string; now: number }) {
  const t = liveTotals(d.perMinute);
  const recent = d.recent.slice(0, RECENT_ROWS);
  return (
    <div className="ov-live">
      <dl className="ov-live-stats">
        <div>
          <dt>Cost</dt>
          <dd>{fmtUsd(t.costUsd)}</dd>
        </div>
        <div>
          <dt>Requests</dt>
          <dd>{fmtInt(t.requests)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{fmtCompact(t.tokens)}</dd>
        </div>
        <div>
          <dt>Last event</dt>
          <dd>{fmtRelative(d.lastReceivedTs, now)}</dd>
        </div>
      </dl>
      <MinuteBars d={d} tz={tz} />
      {recent.length > 0 && (
        <table className="data-table ov-mini-table ov-live-recent">
          <caption className="sr-only">Latest requests</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Model</th>
              <th scope="col" className="num hide-sm">
                Latency
              </th>
              <th scope="col" className="num">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.requestId}>
                <td>{fmtTime(r.ts, tz)}</td>
                <td>{modelLabel(r.model)}</td>
                <td className="num hide-sm">{fmtMs(r.durationMs)}</td>
                <td className="num">{fmtUsd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Last hour from OpenTelemetry events: near-real-time, ahead of the 5-minute transcript sync. */
export function LiveStrip() {
  const { tz, now } = useControls();
  const state = useApi((c, signal) => c.live(MINUTES, { signal }), [], { auto: 'live' });
  return (
    <Card title="Live" subtitle={`Last ${MINUTES} minutes from OpenTelemetry, cost per minute`} refreshing={state.refreshing} footer={<CostNote compact />} className="ov-live-card">
      <AsyncView
        state={state}
        isEmpty={isQuiet}
        empty={
          <EmptyState title="No live events in the last hour" icon="activity">
            Live data needs Claude Code's OpenTelemetry export pointed at your API. Transcript totals above still update every 5 minutes.
          </EmptyState>
        }
        skeletonHeight={120}
      >
        {(d) => <LiveBody d={d} tz={tz} now={now} />}
      </AsyncView>
    </Card>
  );
}
