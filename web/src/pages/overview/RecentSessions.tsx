import type { SessionRow } from '@ccu/shared';
import { AsyncView, Card, CostNote, EmptyState } from '../../components';
import { fmtDuration, fmtRelative, fmtUsd, modelLabel } from '../../format';
import { useApi } from '../../hooks/useApi';
import { href } from '../../router';
import { useControls } from '../../state/controls';

const LIMIT = 6;

function sessionTitle(s: SessionRow): string {
  return s.title?.trim() || `Session ${s.sessionId.slice(0, 8)}`;
}

export function RecentSessions() {
  const { range, now } = useControls();
  const state = useApi((c, signal) => c.sessions({ ...range, sort: 'recent', limit: LIMIT }, { signal }), [range.from, range.to]);
  return (
    <Card
      title="Recent sessions"
      subtitle="Most recently active, USD"
      actions={
        <a className="btn btn-sm btn-ghost" href={href('/sessions')}>
          All sessions
        </a>
      }
      refreshing={state.refreshing}
      footer={<CostNote compact />}
    >
      <AsyncView state={state} isEmpty={(d) => d.sessions.length === 0} empty={<EmptyState title="No sessions in this range" icon="list" />} skeletonHeight={180}>
        {(d) => (
          <table className="data-table ov-mini-table">
            <caption className="sr-only">Recent sessions with API-equivalent cost</caption>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col" className="hide-sm">
                  Models
                </th>
                <th scope="col" className="num hide-sm">
                  Duration
                </th>
                <th scope="col" className="num">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {d.sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td className="ov-cell-main">
                    <a href={href(`/sessions/${encodeURIComponent(s.sessionId)}`)} className="cell-strong ov-ellipsis" title={sessionTitle(s)}>
                      {sessionTitle(s)}
                    </a>
                    <span className="muted small">
                      {s.projectLabel}, {fmtRelative(s.lastTs, now)}
                    </span>
                  </td>
                  <td className="hide-sm">{s.models.map(modelLabel).join(', ') || '–'}</td>
                  <td className="num hide-sm">{fmtDuration(s.durationSeconds)}</td>
                  <td className="num">{fmtUsd(s.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncView>
    </Card>
  );
}
