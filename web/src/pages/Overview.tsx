import type { SummaryResponse } from '@ccu/shared';
import { AsyncView, Icon } from '../components';
import { modelLabel } from '../format';
import { useNow } from '../hooks/useNow';
import { useApi } from '../hooks/useApi';
import { useControls } from '../state/controls';
import { CostByModel } from './overview/CostByModel';
import { KpiRow } from './overview/KpiRow';
import { LiveStrip } from './overview/LiveStrip';
import { PlanLimits } from './overview/PlanLimits';
import { RecentSessions } from './overview/RecentSessions';
import { TopProjects } from './overview/TopProjects';
import './overview/overview.css';

function UnpricedNotice({ s }: { s: SummaryResponse }) {
  if (!s.hasUnpriced) return null;
  const names = s.unpricedModels.map(modelLabel).join(', ');
  return (
    <p className="notice notice-warning ov-notice" role="status">
      <Icon name="alert" size={14} />
      <span>
        <strong>Some usage has no price.</strong> {names ? `${names} ${s.unpricedModels.length === 1 ? 'is' : 'are'}` : 'Some models are'} missing from the pricing
        table, so costs below are undercounted. Token counts are still exact.
      </span>
    </p>
  );
}

export default function Overview() {
  const { tz, dataNow } = useControls();
  const now = useNow(1000);
  const summary = useApi((c, signal) => c.summary(tz, { signal }), [tz]);

  return (
    <div className="page ov-page">
      <AsyncView state={summary} skeletonHeight={140}>
        {(s, refreshing) => (
          <>
            <UnpricedNotice s={s} />
            <KpiRow s={s} refreshing={refreshing} />
            <PlanLimits s={s} now={now} tz={tz} refreshing={refreshing} />
          </>
        )}
      </AsyncView>
      <div className="ov-grid ov-grid-chart">
        <CostByModel now={dataNow} tz={tz} />
        <LiveStrip />
      </div>
      <div className="ov-grid ov-grid-lists">
        <TopProjects />
        <RecentSessions />
      </div>
      <p className="muted small">Times in {tz}.</p>
    </div>
  );
}
