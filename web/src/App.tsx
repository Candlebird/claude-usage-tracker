import { useCallback, useState, type ReactNode } from 'react';
import { EmptyState } from './components';
import { clearConnection, isDemoMode, loadConnection, saveConnection, type Connection } from './connection';
import Activity from './pages/Activity';
import Connect from './pages/Connect';
import Limits from './pages/Limits';
import Models from './pages/Models';
import Overview from './pages/Overview';
import Projects from './pages/Projects';
import SessionDetail from './pages/SessionDetail';
import Sessions from './pages/Sessions';
import Settings from './pages/Settings';
import { href, matchPath, useRoute, type Route } from './router';
import { AppShell } from './shell/AppShell';
import { ApiProvider, type DisconnectReason } from './state/api';
import { ControlsProvider, browserTimeZone } from './state/controls';

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
          {page.element}
        </AppShell>
      </ApiProvider>
    </ControlsProvider>
  );
}
