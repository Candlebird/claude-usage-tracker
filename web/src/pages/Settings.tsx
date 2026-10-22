import { Icon } from '../components';
import { useApi } from '../hooks/useApi';
import { href } from '../router';
import { useControls } from '../state/controls';
import { AlertsCard } from './settings/AlertsCard';
import { AppearanceCard } from './settings/AppearanceCard';
import { ConnectionCard } from './settings/ConnectionCard';
import { HealthStrip } from './settings/HealthStrip';
import { QualityCard } from './settings/QualityCard';
import { StorageCard } from './settings/StorageCard';
import { SyncCard } from './settings/SyncCard';
import './settings/settings.css';

/** Settings & Health: is the pipeline healthy, and how should it alert me. */
export default function Settings() {
  const { now, tz } = useControls();
  const status = useApi((c, signal) => c.status({ signal }), [], { auto: 'live' });
  const settings = useApi((c, signal) => c.getSettings({ signal }), []);
  const staleMinutes = settings.data?.staleSyncMinutes ?? 60;

  return (
    <div className="page">
      <nav className="more-links" aria-label="More pages">
        <a href={href('/models')}>
          <Icon name="cpu" /> Models
        </a>
        <a href={href('/activity')}>
          <Icon name="activity" /> Activity
        </a>
      </nav>

      <HealthStrip status={status} settings={settings.data} now={now} />

      <div className="settings-grid">
        <div className="settings-col">
          <SyncCard state={status} now={now} tz={tz} staleMinutes={staleMinutes} />
          <StorageCard state={status} now={now} />
          <QualityCard state={status} now={now} tz={tz} />
        </div>
        <div className="settings-col">
          <AlertsCard state={settings} />
          <ConnectionCard />
          <AppearanceCard tz={tz} />
        </div>
      </div>
    </div>
  );
}
