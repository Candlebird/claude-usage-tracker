import type { IconName } from '../components/icons';

export interface NavItem {
  path: string;
  label: string;
  /** Shorter label for the phone tab bar. */
  short: string;
  icon: IconName;
  /** Shown in the phone tab bar (the rest live under "More" on Settings). */
  primary: boolean;
}

export const NAV: readonly NavItem[] = [
  { path: '/', label: 'Overview', short: 'Overview', icon: 'overview', primary: true },
  { path: '/limits', label: 'Limits', short: 'Limits', icon: 'gauge', primary: true },
  { path: '/projects', label: 'Projects', short: 'Projects', icon: 'folder', primary: true },
  { path: '/sessions', label: 'Sessions', short: 'Sessions', icon: 'list', primary: true },
  { path: '/models', label: 'Models', short: 'Models', icon: 'cpu', primary: false },
  { path: '/activity', label: 'Activity', short: 'Activity', icon: 'activity', primary: false },
  { path: '/settings', label: 'Settings', short: 'More', icon: 'settings', primary: true },
];

/** The nav item a path belongs to (`/sessions/abc` -> Sessions). */
export function activeNav(path: string): NavItem | undefined {
  if (path === '/' || path === '') return NAV[0];
  const first = '/' + (path.split('/').filter(Boolean)[0] ?? '');
  return NAV.find((n) => n.path === first);
}

/** Pages whose content depends on the global date range (others hide the control). */
export const RANGED_PATHS = new Set(['/', '/projects', '/sessions', '/models', '/limits']);
