import { useMemo } from 'react';
import type { LimitsResponse, Settings } from '@ccu/shared';
import { Card, EmptyState } from '../../components';
import { fmtDateTime, fmtPct, fmtRatio } from '../../format';
import { HistoryChart } from './HistoryChart';
import { historyStats, hitsForWindow, orderWindowKeys, thresholdsFor, windowColors } from './model';

export interface HistoryCardProps {
  data: LimitsResponse;
  settings: Settings | undefined;
  tz: string;
  refreshing: boolean;
}

/** Small multiples: one utilization chart per window, sharing the x range so resets line up. */
export function HistoryCard({ data, settings, tz, refreshing }: HistoryCardProps) {
  const keys = useMemo(() => orderWindowKeys(data.windows.map((w) => w.key)), [data.windows]);
  const colors = useMemo(() => windowColors(keys), [keys]);
  const domain = useMemo(() => [data.from, data.to] as const, [data.from, data.to]);
  const windows = keys.map((k) => data.windows.find((w) => w.key === k)!).filter((w) => w.points.length > 0);

  return (
    <Card
      title="Utilization history"
      subtitle="Percent of each plan window used, as reported by the usage endpoint"
      refreshing={refreshing}
      footer={<HistoryKey />}
    >
      {windows.length === 0 ? (
        <EmptyState title="No limit snapshots in this range">Snapshots arrive with each sync while you use Claude Code.</EmptyState>
      ) : (
        <div className="lim-multiples">
          {windows.map((w) => {
            const thresholds = thresholdsFor(w.key, settings);
            const stats = historyStats(w.points, thresholds[0]);
            const hits = hitsForWindow(data.hits, w.key).filter((h) => h.ts >= data.from && h.ts <= data.to);
            return (
              <figure className="lim-multiple" key={w.key} aria-label={`${w.label} utilization over the selected range`}>
                <figcaption className="lim-multiple-head">
                  <span className="lim-multiple-title">
                    <span className="swatch" style={{ background: colors.get(w.key) }} aria-hidden="true" />
                    {w.label}
                  </span>
                  <dl className="lim-inline-stats">
                    <div>
                      <dt>Now</dt>
                      <dd>{fmtPct(stats.latest, 0)}</dd>
                    </div>
                    <div title={stats.peakTs != null ? fmtDateTime(stats.peakTs, tz) : undefined}>
                      <dt>Peak</dt>
                      <dd>{fmtPct(stats.peak, 0)}</dd>
                    </div>
                    <div>
                      <dt>Above {thresholds[0]}%</dt>
                      <dd>{fmtRatio(stats.shareAboveWarning, 0)}</dd>
                    </div>
                    <div>
                      <dt>Resets</dt>
                      <dd>{stats.resets}</dd>
                    </div>
                    {hits.length > 0 && (
                      <div>
                        <dt>Hits</dt>
                        <dd>{hits.length}</dd>
                      </div>
                    )}
                  </dl>
                </figcaption>
                <HistoryChart
                  label={w.label}
                  points={w.points}
                  hits={hits}
                  color={colors.get(w.key) ?? 'var(--series-other)'}
                  thresholds={thresholds}
                  domain={domain}
                  tz={tz}
                />
              </figure>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function HistoryKey() {
  return (
    <ul className="lim-key" aria-label="Chart key">
      <li>
        <svg width="18" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink-muted)" strokeDasharray="4 3" />
        </svg>
        Alert thresholds
      </li>
      <li>
        <svg width="8" height="12" aria-hidden="true">
          <line x1="4" y1="0" x2="4" y2="12" stroke="var(--ink-muted)" strokeOpacity="0.6" />
        </svg>
        Window reset
      </li>
      <li>
        <svg width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" fill="var(--critical)" />
        </svg>
        Limit hit
      </li>
    </ul>
  );
}
