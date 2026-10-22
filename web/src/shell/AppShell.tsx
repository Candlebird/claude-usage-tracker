import type { ReactNode } from 'react';
import { DateRangeControl } from '../components/DateRangeControl';
import { Icon } from '../components/icons';
import { href } from '../router';
import { useApiContext } from '../state/api';
import { useControls } from '../state/controls';
import { useTheme } from '../theme';
import { NAV, RANGED_PATHS, activeNav } from './nav';

export interface AppShellProps {
  path: string;
  title: string;
  children: ReactNode;
}

/**
 * Sidebar on desktop, top bar + bottom tab bar on phones (CSS switches at 768px).
 * Filters live in one row in the top bar, above every page's content.
 */
export function AppShell({ path, title, children }: AppShellProps) {
  const active = activeNav(path);
  const { demo } = useApiContext();
  const { refresh, tz } = useControls();
  const { resolved, toggle } = useTheme();
  const ranged = RANGED_PATHS.has(path);

  return (
    <div className="shell">
      {/* A button, not href="#main": the hash is the router. */}
      <button type="button" className="skip-link" onClick={() => document.getElementById('main')?.focus()}>
        Skip to content
      </button>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Claude Usage</span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.path}>
              <a href={href(n.path)} className={active === n ? 'is-active' : undefined} aria-current={active === n ? 'page' : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          {demo && <span className="demo-pill">Demo data</span>}
          <span className="tz" title="Times shown in your browser's timezone">
            {tz}
          </span>
        </div>
      </nav>

      <div className="main-col">
        <header className="topbar">
          <h1 className="page-title">{title}</h1>
          <div className="topbar-controls">
            {ranged && <DateRangeControl />}
            {demo && <span className="demo-pill demo-pill-sm">Demo</span>}
            <button type="button" className="icon-btn" onClick={refresh} aria-label="Refresh now" title="Refresh now (live data every 60s, totals every 5 min)">
              <Icon name="refresh" />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={toggle}
              aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={resolved === 'dark' ? 'Light theme' : 'Dark theme'}
            >
              <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
            </button>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {NAV.filter((n) => n.primary).map((n) => {
          const on = active === n || (n.path === '/settings' && !active?.primary);
          return (
            <a key={n.path} href={href(n.path)} className={on ? 'is-active' : undefined} aria-current={on ? 'page' : undefined}>
              <Icon name={n.icon} size={20} />
              <span>{n.short}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
