import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createApiClient, demoTransport, httpTransport, type ApiClient } from '../api';
import type { Connection } from '../connection';

export type DisconnectReason = 'user' | 'unauthorized';

export interface ApiContextValue {
  client: ApiClient;
  demo: boolean;
  connection: Connection | null;
  /** Clears the saved connection and returns to the connect screen. */
  disconnect(): void;
  /** Data hooks call this when a request returns 401. */
  onUnauthorized(): void;
}

const Ctx = createContext<ApiContextValue | null>(null);

export function ApiProvider(props: {
  children: ReactNode;
  demo: boolean;
  connection: Connection | null;
  tz: string;
  onDisconnect(reason: DisconnectReason): void;
  /** Overrides the client (tests). */
  client?: ApiClient;
}) {
  const { demo, connection, tz, onDisconnect, client: injected } = props;
  const value = useMemo<ApiContextValue>(() => {
    const client =
      injected ??
      (demo || !connection ? createApiClient(demoTransport(tz), true) : createApiClient(httpTransport(connection), false));
    return {
      client,
      demo,
      connection,
      disconnect: () => onDisconnect('user'),
      onUnauthorized: () => {
        if (!demo) onDisconnect('unauthorized');
      },
    };
  }, [demo, connection, tz, onDisconnect, injected]);
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export function useApiContext(): ApiContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApiContext must be used inside <ApiProvider>');
  return v;
}
