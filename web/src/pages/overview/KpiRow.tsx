import type { SummaryResponse } from '@ccu/shared';
import { CostNote, KpiTile } from '../../components';
import { fmtCompact, fmtInt, fmtPct, fmtRatio, fmtTokens, fmtUsd } from '../../format';
import { budgetUsedPct, weekVsMonthPct } from './model';

function budgetLine(s: SummaryResponse): string | null {
  const pct = budgetUsedPct(s.today.costUsd, s.dailyBudgetUsd);
  return pct == null ? null : `${fmtPct(pct, 0)} of ${fmtUsd(s.dailyBudgetUsd)} daily budget`;
}

/** Headline figures. Today is the single hero; every dollar is API-equivalent (note below the row). */
export function KpiRow({ s, refreshing }: { s: SummaryResponse; refreshing: boolean }) {
  const budget = budgetLine(s);
  return (
    <section className="ov-kpis-wrap" aria-label="Key figures">
      <div className="ov-kpis">
        <KpiTile
          hero
          label="Today"
          value={fmtUsd(s.today.costUsd)}
          sub={
            <>
              {fmtTokens(s.today.totalTokens)} tokens, {fmtInt(s.today.requests)} requests
              {budget && <span className="ov-kpi-budget">{budget}</span>}
            </>
          }
          refreshing={refreshing}
        />
        <KpiTile
          label="Last 7 days"
          value={fmtUsd(s.last7d.costUsd)}
          sub={`${fmtTokens(s.last7d.totalTokens)} tokens`}
          delta={{ pct: weekVsMonthPct(s.last7d, s.last30d), label: 'daily avg vs 30d', goodWhen: 'neither' }}
          refreshing={refreshing}
        />
        <KpiTile
          label="Last 30 days"
          value={fmtUsd(s.last30d.costUsd)}
          sub={`${fmtTokens(s.last30d.totalTokens)} tokens, ${fmtInt(s.last30d.sessions)} sessions`}
          refreshing={refreshing}
        />
        <KpiTile
          label="Cache hit rate, 7d"
          value={fmtRatio(s.last7d.cacheHitRate)}
          sub={`${fmtUsd(s.last7d.cacheSavingsUsd)} saved vs uncached`}
          refreshing={refreshing}
        />
        <KpiTile
          label="Burn rate"
          value={`${fmtUsd(s.burnRate.costPerHour)}/h`}
          sub={`${fmtCompact(s.burnRate.tokensPerMinute)} tokens/min, last ${s.burnRate.windowMinutes} min`}
          refreshing={refreshing}
        />
      </div>
      <CostNote />
    </section>
  );
}
