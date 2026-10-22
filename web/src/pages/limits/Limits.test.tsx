import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LimitsResponse } from '@ccu/shared';
import type { ApiClient } from '../../api';
import { ApiProvider } from '../../state/api';
import { ControlsProvider, browserTimeZone } from '../../state/controls';
import Limits from '../Limits';

beforeAll(() => {
  // Recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Rendered without the router/shell so the test only depends on this page and the demo backend. */
function renderLimits(client?: ApiClient) {
  return render(
    <ControlsProvider>
      <ApiProvider demo connection={null} tz={browserTimeZone()} onDisconnect={() => {}} client={client}>
        <Limits />
      </ApiProvider>
    </ControlsProvider>,
  );
}

/** A client whose every method resolves to `impl` (only limits/getSettings are called by this page). */
function stubClient(impl: (method: string) => Promise<unknown>): ApiClient {
  return new Proxy({}, { get: (_t, method) => () => impl(String(method)) }) as ApiClient;
}

describe('Limits page', () => {
  it('renders every section with demo data', async () => {
    renderLimits();
    expect(await screen.findByText('Utilization history', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText('Weekly pace', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('Current windows')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '5-hour blocks' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Limit hits' })).toBeInTheDocument();
    expect(screen.getByText('Est. block capacity')).toBeInTheDocument();
    expect(screen.getAllByText(/API-equivalent/).length).toBeGreaterThan(0);
  });

  it('shows empty states when there is no limit data', async () => {
    const empty: LimitsResponse = { from: 0, to: 1, windows: [], hits: [], blocks: [], current: [] };
    renderLimits(stubClient((m) => (m === 'limits' ? Promise.resolve(empty) : Promise.reject(new Error('no settings')))));
    expect(await screen.findByText('No limit data yet', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('No limit snapshots in this range')).toBeInTheDocument();
    expect(screen.getByText('No weekly window reported yet')).toBeInTheDocument();
    expect(screen.getByText('No 5-hour blocks in this range')).toBeInTheDocument();
    expect(screen.getByText('No limit hits in this range')).toBeInTheDocument();
  });

  it('shows an error state when the request fails', async () => {
    renderLimits(stubClient(() => Promise.reject(new Error('boom'))));
    expect((await screen.findAllByText(/boom/, {}, { timeout: 3000 })).length).toBeGreaterThan(0);
  });
});
