import { useMemo } from 'react';
import type { LimitsResponse } from '@ccu/shared';
import { Card, EmptyState, Icon } from '../../components';
import { fmtCountdown, fmtDateTime, fmtPct, fmtWeekdayDate } from '../../format';
import { PaceChart } from './PaceChart';
import { buildPaceModel, isWeekly, orderWindowKeys, paceVerdict, windowColors, type PaceModel } from './model';

export interface PaceCardProps {
  /** Limits for (at least) the last 7 days, so every current weekly window is fully covered. */
  data: LimitsResponse;
  now: number;
  tz: string;
  refreshing: boolean;
}

export function PaceCard({ data, now, tz, refreshing }: PaceCardProps) {
  const allKeys = useMemo(() => orderWindowKeys([...data.current.map((w) => w.key), ...data.windows.map((w) => w.key)]), [data]);
  const colors = useMemo(() => windowColors(allKeys), [allKeys]);
  const models = useMemo(
    () =>
      orderWindowKeys(data.current.filter((w) => isWeekly(w.key)).map((w) => w.key)).map((k) => {
        const w = data.current.find((x) => x.key === k)!;
        const history = data.windows.find((x) => x.key === k)?.points ?? [];
        return buildPaceModel(w, history, now);
      }),
    // `now` moves every second; the chart only needs minute resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, Math.floor(now / 60)],
  );

  return (
    <Card
      title="Weekly pace"
      subtitle="Where each weekly window is heading if you keep this window's average rate"
      refreshing={refreshing}
      footer={<PaceKey />}
    >
      {models.length === 0 ? (
        <EmptyState title="No weekly window reported yet">The sync client reports weekly limits after its first run.</EmptyState>
      ) : (
        <div className="lim-pace-grid">
          {models.map((m) => (
            <PacePanel key={m.key} model={m} color={colors.get(m.key) ?? 'var(--series-other)'} now={now} tz={tz} />
          ))}
        </div>
      )}
    </Card>
  );
}

function PacePanel({ model: m, color, now, tz }: { model: PaceModel; color: string; now: number; tz: string }) {
  const verdict = paceVerdict(m.pace);
  const runsOut = m.projectedFullAt != null && m.projectedFullAt < m.resetsAt;
  return (
    <figure className="lim-pace" aria-label={`${m.label}: weekly pace projection`}>
      <figcaption className="lim-multiple-head">
        <span className="lim-multiple-title">
          <span className="swatch" style={{ background: color }} aria-hidden="true" />
          {m.label}
        </span>
        <span className={`lim-verdict lim-verdict-${verdict.tone}`}>
          <Icon name={verdict.tone === 'ok' ? 'check' : 'alert'} size={13} />
          {m.pace != null ? `${m.pace.toFixed(2)}× pace · ` : ''}
          {verdict.text}
        </span>
      </figcaption>
      <PaceChart model={m} color={color} now={now} tz={tz} />
      <dl className="lim-stats">
        <div>
          <dt>Used</dt>
          <dd>{fmtPct(m.utilization, 0)}</dd>
        </div>
        <div>
          <dt>At reset (projected)</dt>
          <dd>{fmtPct(m.projectedAtReset, 0)}</dd>
        </div>
        <div>
          <dt>{runsOut ? 'Runs out' : 'Resets'}</dt>
          <dd title={fmtDateTime(runsOut ? m.projectedFullAt! : m.resetsAt, tz)}>
            {runsOut ? `in ${fmtCountdown(m.projectedFullAt!, now)}` : fmtWeekdayDate(m.resetsAt, tz)}
          </dd>
        </div>
        <div>
          <dt>Daily allowance</dt>
          <dd>{m.allowancePerDay == null ? '—' : `${fmtPct(m.allowancePerDay, 0)}/day`}</dd>
        </div>
        <div>
          <dt>Last 24 h</dt>
          <dd>
            {m.last24h == null ? '—' : `+${fmtPct(m.last24h, 0)}`}
            {m.recentRunsOut && <span className="lim-flag"> faster than allowance</span>}
          </dd>
        </div>
      </dl>
    </figure>
  );
}

function PaceKey() {
  return (
    <ul className="lim-key" aria-label="Chart key">
      <li>
        <svg width="18" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink-2)" strokeWidth="2" />
        </svg>
        Used so far
      </li>
      <li>
        <svg width="18" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink-2)" strokeWidth="2" strokeDasharray="6 4" />
        </svg>
        Projection at the current average rate
      </li>
      <li>
        <svg width="18" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink-muted)" strokeDasharray="2 4" />
        </svg>
        Even pace (100% at reset)
      </li>
    </ul>
  );
}
