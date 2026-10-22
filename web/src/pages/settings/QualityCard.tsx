import type { StatusResponse } from '@ccu/shared';
import { AsyncView, Card } from '../../components';
import { fmtDateTime, fmtInt, fmtRelative } from '../../format';
import type { ApiState } from '../../hooks/useApi';
import { HealthBadge } from './HealthBadge';
import { liveHealth, pricingHealth } from './logic';

/** Unpriced models, incomplete outputs and the OTel live feed: the things that make numbers less exact. */
export function QualityCard({ state, now, tz }: { state: ApiState<StatusResponse>; now: number; tz: string }) {
  return (
    <Card id="settings-quality" title="Data quality" subtitle="What could make the numbers less exact" refreshing={state.refreshing}>
      <AsyncView state={state} skeletonHeight={140}>
        {(st) => {
          const live = liveHealth(st.otelLastReceivedTs, now);
          return (
            <div className="settings-stack">
              <section className="settings-sub" aria-labelledby="quality-pricing">
                <div className="settings-row">
                  <h3 className="settings-subtitle" id="quality-pricing">
                    Pricing
                  </h3>
                  <HealthBadge health={pricingHealth(st.unpricedModels)} />
                </div>
                {st.unpricedModels.length === 0 ? (
                  <p className="muted small">Every model seen has a price, so API-equivalent costs are complete.</p>
                ) : (
                  <>
                    <p className="small">
                      These models have no price yet. Their tokens are counted, but their API-equivalent cost shows as $0, so totals are undercounted
                      until <code>shared/src/pricing.ts</code> is updated.
                    </p>
                    <p className="settings-tags">
                      {st.unpricedModels.map((m) => (
                        <span key={m} className="tag mono">
                          {m}
                        </span>
                      ))}
                    </p>
                  </>
                )}
              </section>

              <section className="settings-sub" aria-labelledby="quality-output">
                <h3 className="settings-subtitle" id="quality-output">
                  Output tokens
                </h3>
                {st.outputIncomplete.requests > 0 ? (
                  <p className="small">
                    {fmtInt(st.outputIncomplete.requests)} request{st.outputIncomplete.requests === 1 ? '' : 's'} ended before the final output count was
                    written, so output tokens are slightly low.
                    {st.outputIncomplete.reportedTs != null && (
                      <span className="muted"> Last reported {fmtRelative(st.outputIncomplete.reportedTs, now)}.</span>
                    )}
                  </p>
                ) : (
                  <p className="muted small">No incomplete outputs reported.</p>
                )}
              </section>

              <section className="settings-sub" aria-labelledby="quality-live">
                <div className="settings-row">
                  <h3 className="settings-subtitle" id="quality-live">
                    Live data (OTel)
                  </h3>
                  <HealthBadge health={live} />
                </div>
                {st.otelLastReceivedTs == null ? (
                  <p className="small">
                    No OpenTelemetry events yet. Live data is optional: transcripts stay the source of truth. Run <code>ccu install</code> and accept the
                    telemetry step to see requests within seconds instead of after the next sync.
                  </p>
                ) : (
                  <p className="small">
                    Last event {fmtRelative(st.otelLastReceivedTs, now)} <span className="muted">· {fmtDateTime(st.otelLastReceivedTs, tz)}</span>. Events
                    only arrive while Claude Code is running.
                  </p>
                )}
              </section>
            </div>
          );
        }}
      </AsyncView>
    </Card>
  );
}
