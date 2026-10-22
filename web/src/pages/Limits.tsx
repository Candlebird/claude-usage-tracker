import { SEVEN_DAY_SECONDS } from '@ccu/shared';
import { AsyncView, Card, EmptyState, LimitGauge } from '../components';
import { useApi } from '../hooks/useApi';
import { useNow } from '../hooks/useNow';
import { useControls } from '../state/controls';
import { BlocksCard } from './limits/BlocksCard';
import { HistoryCard } from './limits/HistoryCard';
import { HitsCard } from './limits/HitsCard';
import { PaceCard } from './limits/PaceCard';
import { orderWindowKeys, thresholdsFor } from './limits/model';
import './limits/limits.css';

const HOUR = 3600;

export default function Limits() {
  const { range, tz, dataNow } = useControls();
  const now = useNow(1000);
  const limits = useApi((c, signal) => c.limits(range, { signal }), [range.from, range.to]);
  // Pace needs the whole current weekly window regardless of the selected range.
  // Built from the aggregate clock so it refetches every 5 min, not every 60 s tick.
  const weekFrom = Math.floor((dataNow - SEVEN_DAY_SECONDS) / HOUR) * HOUR;
  const week = useApi((c, signal) => c.limits({ from: weekFrom, to: dataNow }, { signal }), [weekFrom, dataNow]);
  const settings = useApi((c, signal) => c.getSettings({ signal }), [], { auto: false });
  const s = settings.data;

  return (
    <div className="page lim-page">
      <AsyncView state={limits} skeletonHeight={120}>
        {(d, refreshing) => (
          <>
            <Card title="Current windows" subtitle="Latest reported utilization of each plan window" refreshing={refreshing}>
              {d.current.length === 0 ? (
                <EmptyState title="No limit data yet">Limits appear after the first sync that polls the usage endpoint.</EmptyState>
              ) : (
                <div className="gauge-grid">
                  {orderWindowKeys(d.current.map((w) => w.key)).map((k) => {
                    const w = d.current.find((x) => x.key === k)!;
                    return <LimitGauge key={k} window={w} now={now} tz={tz} thresholds={thresholdsFor(k, s)} />;
                  })}
                </div>
              )}
            </Card>
            <HistoryCard data={d} settings={s} tz={tz} refreshing={refreshing} />
          </>
        )}
      </AsyncView>

      <AsyncView state={week} skeletonHeight={220}>
        {(d, refreshing) => <PaceCard data={d} now={now} tz={tz} refreshing={refreshing} />}
      </AsyncView>

      <AsyncView state={limits} skeletonHeight={200}>
        {(d, refreshing) => (
          <div className="lim-pair">
            <BlocksCard blocks={d.blocks} thresholds={thresholdsFor('five_hour', s)} tz={tz} refreshing={refreshing} />
            <HitsCard hits={d.hits} windows={[...d.current, ...d.windows]} tz={tz} refreshing={refreshing} />
          </div>
        )}
      </AsyncView>
    </div>
  );
}
