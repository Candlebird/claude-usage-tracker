import { AsyncView, Card, CostNote, EmptyState, Sparkline } from '../../components';
import { fmtInt, fmtRatio, fmtUsd, modelLabel } from '../../format';
import { useApi } from '../../hooks/useApi';
import { href } from '../../router';
import { useControls } from '../../state/controls';
import { rangeLabel, topByCost } from './model';

const TOP_N = 5;

export function TopProjects() {
  const { preset, range, tz } = useControls();
  const state = useApi((c, signal) => c.projects({ ...range, tz }, { signal }), [range.from, range.to, tz]);
  return (
    <Card
      title="Top projects"
      subtitle={`${rangeLabel(preset, range, tz)}, by cost (USD)`}
      actions={
        <a className="btn btn-sm btn-ghost" href={href('/projects')}>
          All projects
        </a>
      }
      refreshing={state.refreshing}
      footer={<CostNote compact />}
    >
      <AsyncView
        state={state}
        isEmpty={(d) => topByCost(d.projects, TOP_N, (p) => p.project).length === 0}
        empty={<EmptyState title="No project usage in this range" icon="folder" />}
        skeletonHeight={180}
      >
        {(d) => {
          const rows = topByCost(d.projects, TOP_N, (p) => p.project);
          const total = d.projects.reduce((s, p) => s + p.costUsd, 0);
          return (
            <table className="data-table ov-mini-table">
              <caption className="sr-only">Top projects by API-equivalent cost</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col" className="hide-sm">
                    Daily cost
                  </th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                  <th scope="col" className="num hide-sm">
                    Share
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.project}>
                    <td className="ov-cell-main">
                      <a href={href('/sessions', { project: p.project })} className="cell-strong">
                        {p.label}
                      </a>
                      <span className="muted small">
                        {fmtInt(p.sessions)} {p.sessions === 1 ? 'session' : 'sessions'}
                        {p.topModel ? `, mostly ${modelLabel(p.topModel)}` : ''}
                      </span>
                    </td>
                    <td className="hide-sm">
                      <Sparkline values={p.sparkline.map((x) => x.costUsd)} width={88} height={22} />
                    </td>
                    <td className="num">{fmtUsd(p.costUsd)}</td>
                    <td className="num hide-sm">{fmtRatio(total > 0 ? p.costUsd / total : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </AsyncView>
    </Card>
  );
}
