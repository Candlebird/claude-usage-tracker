import { lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import { EmptyState } from './components';
import { clearConnection, isDemoMode, loadConnection, saveConnection, type Connection } from './connection';
import Connect from './pages/Connect';
import { href, matchPath, useRoute, type Route } from './router';
import { AppShell } from './shell/AppShell';
import { ApiProvider, type DisconnectReason } from './state/api';
import { ControlsProvider, browserTimeZone } from './state/controls';

// Each page is its own chunk, loaded on first visit (Connect stays eager: it is the first screen).
const Activity = lazy(() => import('./pages/Activity'));
const Limits = lazy(() => import('./pages/Limits'));
const Models = lazy(() => import('./pages/Models'));
const Overview = lazy(() => import('./pages/Overview'));
const Projects = lazy(() => import('./pages/Projects'));
const SessionDetail = lazy(() => import('./pages/SessionDetail'));
const Sessions = lazy(() => import('./pages/Sessions'));
const Settings = lazy(() => import('./pages/Settings'));

function PageLoading() {
  return <div className="page-loading" role="status" aria-label="Loading page" />;
}

interface Resolved {
  title: string;
  /** Path the shell treats as current (detail pages highlight their list). */
  navPath: string;
  element: ReactNode;
}

/** Maps a hash route to its page. Exported for tests. */
export function resolveRoute(route: Route): Resolved {
  const p = route.path;
  const sessionMatch = matchPath('/sessions/:id', p);
  if (sessionMatch) return { title: 'Session', navPath: p, element: <SessionDetail key={sessionMatch.id} id={sessionMatch.id!} /> };
  switch (p) {
    case '/':
      return { title: 'Overview', navPath: p, element: <Overview /> };
    case '/limits':
      return { title: 'Limits', navPath: p, element: <Limits /> };
    case '/projects':
      return { title: 'Projects', navPath: p, element: <Projects /> };
    case '/sessions':
      return { title: 'Sessions', navPath: p, element: <Sessions route={route} /> };
    case '/models':
      return { title: 'Models', navPath: p, element: <Models /> };
    case '/activity':
      return { title: 'Activity', navPath: p, element: <Activity /> };
    case '/settings':
      return { title: 'Settings', navPath: p, element: <Settings /> };
    default:
      return {
        title: 'Not found',
        navPath: p,
        element: (
          <EmptyState title="Page not found" icon="info" action={<a href={href('/')}>Go to Overview</a>}>
            Nothing lives at {p}.
          </EmptyState>
        ),
      };
  }
}

export default function App() {
  // Demo mode is decided once per page load: switching it means a reload anyway.
  const [demo] = useState(() => isDemoMode());
  const [connection, setConnection] = useState<Connection | null>(() => (demo ? null : loadConnection()));
  const [notice, setNotice] = useState<string | null>(null);
  const [tz] = useState(browserTimeZone);
  const route = useRoute();

  const onDisconnect = useCallback((reason: DisconnectReason) => {
    clearConnection();
    setConnection(null);
    setNotice(reason === 'unauthorized' ? 'Your token was rejected. Connect again.' : null);
  }, []);

  const onConnected = useCallback((c: Connection) => {
    saveConnection(c);
    setNotice(null);
    setConnection(c);
  }, []);

  if (!demo && !connection) return <Connect onConnected={onConnected} notice={notice} />;

  const page = resolveRoute(route);
  return (
    <ControlsProvider>
      <ApiProvider demo={demo} connection={connection} tz={tz} onDisconnect={onDisconnect}>
        <AppShell path={page.navPath} title={page.title}>
          <Suspense fallback={<PageLoading />}>{page.element}</Suspense>
        </AppShell>
      </ApiProvider>
    </ControlsProvider>
  );
}
