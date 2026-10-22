import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_ROUTES, nowSeconds, type PeriodKpis, type SummaryResponse } from '@ccu/shared';
import { createApiClient, demoTransport, type ApiClient, type Transport } from '../../api';
import { ApiProvider } from '../../state/api';
import { ControlsProvider } from '../../state/controls';
import Overview from '../Overview';

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

function renderWith(client: ApiClient) {
  return render(
    <ApiProvider demo connection={null} tz="UTC" onDisconnect={() => {}} client={client}>
      <ControlsProvider>
        <Overview />
      </ControlsProvider>
    </ApiProvider>,
  );
}

const zeroKpis: PeriodKpis = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  webSearch: 0,
  totalTokens: 0,
  requests: 0,
  costUsd: 0,
  sessions: 0,
  cacheHitRate: null,
  cacheSavingsUsd: 0,
};

function emptySummary(now: number): SummaryResponse {
  return {
    generatedAt: now,
    tz: 'UTC',
    today: zeroKpis,
    last7d: zeroKpis,
    last30d: zeroKpis,
    burnRate: { windowMinutes: 60, costPerHour: 0, tokensPerMinute: 0, requests: 0, source: 'merged' },
    limits: [],
    sync: { lastSyncTs: null, ageSeconds: null, pending: 0, device: null },
    unpricedModels: [],
    hasUnpriced: false,
    dailyBudgetUsd: null,
  } as unknown as SummaryResponse;
}

/** A synthetic backend with no usage at all. */
const emptyTransport: Transport = async (_method, path) => {
  const now = nowSeconds();
  switch (path) {
    case API_ROUTES.summary:
      return emptySummary(now);
    case API_ROUTES.timeseries:
      return { from: now - 7 * 86400, to: now, bucket: 'hour', group: 'model', metric: 'cost', tz: 'UTC', series: [] };
    case API_ROUTES.projects:
      return { projects: [] };
    case API_ROUTES.sessions:
      return { total: 0, limit: 6, offset: 0, sort: 'recent', sessions: [] };
    case API_ROUTES.live:
      return { minutes: 60, perMinute: [], recent: [], lastReceivedTs: null };
    default:
      throw new Error(`unexpected ${path}`);
  }
};

describe('Overview page', () => {
  it('renders every section from demo data', async () => {
    renderWith(createApiClient(demoTransport('UTC', nowSeconds, 0), true));
    expect(await screen.findByRole('heading', { name: 'Plan limits' })).toBeInTheDocument();
    for (const name of ['Cost by model', 'Live', 'Top projects', 'Recent sessions']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Last 30 days')).toBeInTheDocument();
    expect(screen.getAllByText(/API-equivalent/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('meter').length).toBeGreaterThan(0);

    const projects = await screen.findByRole('table', { name: /top projects/i }, { timeout: 3000 });
    expect(within(projects).getAllByRole('link').length).toBeGreaterThan(0);
    const sessions = await screen.findByRole('table', { name: /recent sessions/i });
    const links = within(sessions).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute('href')).toMatch(/^#\/sessions\//);
    expect(await screen.findByRole('table', { name: /cost by model/i })).toBeInTheDocument();
  });

  it('shows empty states when there is no usage', async () => {
    renderWith(createApiClient(emptyTransport, false));
    expect(await screen.findByText('No limit data yet')).toBeInTheDocument();
    expect(await screen.findByText('No usage in the last 7 days')).toBeInTheDocument();
    expect(await screen.findByText('No live events in the last hour')).toBeInTheDocument();
    expect(await screen.findByText('No project usage in this range')).toBeInTheDocument();
    expect(await screen.findByText('No sessions in this range')).toBeInTheDocument();
    expect(screen.getByText('Not synced yet')).toBeInTheDocument();
  });

  it('shows an error with retry for each failed request', async () => {
    const failing: Transport = async () => {
      throw new Error('Synthetic outage');
    };
    renderWith(createApiClient(failing, false));
    // summary, timeseries, live, projects, sessions
    await waitFor(() => expect(screen.getAllByText('Synthetic outage')).toHaveLength(5));
    expect(screen.getAllByRole('button', { name: /try again/i })).toHaveLength(5);
  });

  it('warns when some models are unpriced', async () => {
    const transport: Transport = async (method, path, query, body, opts) => {
      if (path === API_ROUTES.summary) return { ...emptySummary(nowSeconds()), hasUnpriced: true, unpricedModels: ['claude-test-9'] };
      return emptyTransport(method, path, query, body, opts);
    };
    renderWith(createApiClient(transport, false));
    expect(await screen.findByText(/some usage has no price/i)).toBeInTheDocument();
  });
});
