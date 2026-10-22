import { Icon, type IconName } from '../../components';
import type { Status } from '../../palette';
import type { Health } from './logic';

const ICON: Record<Status, IconName> = { ok: 'check', warning: 'alert', serious: 'alert', critical: 'octagon' };

/** Status icon + a health-specific word (the kit's StatusBadge words are limit-specific). Never color alone. */
export function HealthBadge({ health }: { health: Health }) {
  return (
    <span className={`status-badge status-${health.status}`}>
      <Icon name={ICON[health.status]} size={14} />
      {health.label}
    </span>
  );
}
