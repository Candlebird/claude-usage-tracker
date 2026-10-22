import { useMemo, useState } from 'react';
import type { ProjectRow, SessionRow } from '@ccu/shared';
import { AsyncView, CostNote, EmptyState, Segmented, StackedBarChart, isAllZero } from '../../components';
import { agentKindLabel, fmtDateTime, fmtInt, fmtRatio, fmtRelative, fmtTokens, fmtUsd, modelLabel } from '../../format';
import { useApi } from '../../hooks/useApi';
import { agentKindColor, modelColorMap } from '../../palette';
import { href } from '../../router';
import { useControls } from '../../state/controls';
import { ShareBar } from '../sessions/ShareBar';
import { seriesTotals } from '../sessions/shares';
import { sessionTitle } from '../sessions/sessionsQuery';

type Split = 'model' | 'agent_kind';
const SPLITS = [
  { value: 'model' as const, label: 'Model' },
  { value: 'agent_kind' as const, label: 'Agent kind' },
];
const TOP_SESSIONS = 8;

const usd = (v: number) => fmtUsd(v);
const usdAxis = (v: number) => fmtUsd(v, { compact: true });

export interface ProjectDrawerBodyProps {
  project: string;
  /** Undefined when the project had no usage in the selected range. */
  row: ProjectRow | undefined;
  color: string;
}

/** Drawer content for one project: summary, cost over time, and its priciest sessions. */
export function ProjectDrawerBody({ project, row, color }: ProjectDrawerBodyProps) {
  const { range, bucket, tz, now } = useControls();
  const [split, setSplit] = useState<Split>('model');

  const series = useApi(
    (c, signal) => c.timeseries({ ...range, bucket, group: split, metric: 'cost', tz, project }, { signal }),
    [range.from, range.to, bucket, tz, project, split],
  );
  const sessions = useApi((c, signal) => c.sessions({ ...range, project, sort: 'cost', limit: TOP_SESSIONS }, { signal }), [range.from, range.to, project]);

  const modelColors = useMemo(() => modelColorMap(split === 'model' ? (series.data?.series ?? []).map((s) => s.key) : []), [series.data, split]);
  const style = useMemo(
    () =>
      split === 'model'
        ? { colorFor: (k: string) => modelColors.get(k) ?? 'var(--series-other)', labelFor: modelLabel }
        : { colorFor: agentKindColor, labelFor: agentKindLabel },
    [split, modelColors],
  );

  return (
    <div className="proj-drawer">
      {row ? (
        <dl className="proj-summary">
          <div className="proj-summary-hero">
            <dt>
              <span className="swatch" style={{ background: color }} aria-hidden="true" /> API-equivalent cost
            </dt>
            <dd>{fmtUsd(row.costUsd)}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{fmtTokens(row.totalTokens)}</dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd>{fmtInt(row.sessions)}</dd>
          </div>
          <div>
            <dt>Cache hit</dt>
            <dd>{fmtRatio(row.cacheHitRate)}</dd>
          </div>
          <div>
            <dt>Top model</dt>
            <dd>{modelLabel(row.topModel)}</dd>
          </div>
          <div>
            <dt>Last active</dt>
            <dd>{fmtRelative(row.lastActive, now)}</dd>
          </div>
        </dl>
      ) : (
        <p className="notice">No usage for this project in the selected range.</p>
      )}
      {row?.path && <p className="mono small muted break">{row.path}</p>}

      <section className="proj-section" aria-labelledby="proj-cost-h">
        <div className="proj-section-head">
          <h3 id="proj-cost-h">Cost over time</h3>
          <Segmented<Split> label="Split project cost by" options={SPLITS} value={split} onChange={setSplit} size="sm" />
        </div>
        <AsyncView state={series} skeletonHeight={220} isEmpty={(d) => isAllZero(d.series)} empty={<EmptyState title="No cost in this range" />}>
          {(d) => (
            <>
              <StackedBarChart
                series={d.series}
                colorFor={style.colorFor}
                labelFor={style.labelFor}
                tz={tz}
                bucket={bucket}
                format={usd}
                axisFormat={usdAxis}
                costNote
                height={200}
                ariaLabel={`Cost of ${row?.label ?? project} per ${bucket} by ${split === 'model' ? 'model' : 'agent kind'}`}
              />
              <ShareBar
                label={split === 'model' ? 'Project cost by model' : 'Project cost by agent kind'}
                format={usd}
                parts={seriesTotals(d.series).map((t) => ({ key: t.key, label: style.labelFor(t.key), value: t.total, color: style.colorFor(t.key) }))}
              />
            </>
          )}
        </AsyncView>
      </section>

      <section className="proj-section" aria-labelledby="proj-sess-h">
        <div className="proj-section-head">
          <h3 id="proj-sess-h">Top sessions</h3>
          <a className="small" href={href('/sessions', { project })}>
            All sessions in this project
          </a>
        </div>
        <AsyncView state={sessions} skeletonHeight={160} isEmpty={(d) => d.sessions.length === 0} empty={<EmptyState title="No sessions in this range" />}>
          {(d) => (
            <ol className="proj-sessions">
              {d.sessions.map((s) => (
                <SessionLink key={s.sessionId} s={s} tz={tz} />
              ))}
            </ol>
          )}
        </AsyncView>
      </section>
      <CostNote />
    </div>
  );
}

function SessionLink({ s, tz }: { s: SessionRow; tz: string }) {
  return (
    <li>
      <a href={href(`/sessions/${encodeURIComponent(s.sessionId)}`)}>
        <span className="proj-sess-main">
          <span className="proj-sess-title">{sessionTitle(s)}</span>
          <span className="proj-sess-sub">
            {fmtDateTime(s.firstTs, tz)}
            {s.gitBranch ? ` · ${s.gitBranch}` : ''}
          </span>
        </span>
        <span className="proj-sess-cost">{fmtUsd(s.costUsd)}</span>
      </a>
    </li>
  );
}
