import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App, { resolveRoute } from '../src/App';
import { parseHash } from '../src/router';

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
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

describe('App smoke', () => {
  it('shows the connect screen when there is no connection', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /connect to your usage api/i })).toBeInTheDocument();
    expect(screen.getByText('Read token')).toBeInTheDocument();
  });

  it('renders the shell and Overview in demo mode', async () => {
    window.history.replaceState(null, '', '/?demo#/');
    render(<App />);
    const navs = screen.getAllByRole('navigation');
    expect(navs.length).toBeGreaterThan(0);
    for (const label of ['Overview', 'Limits', 'Projects', 'Sessions']) {
      expect(within(navs[0]!).getByText(label)).toBeInTheDocument();
    }
    expect(await screen.findByText(/plan limits/i, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('renders every page in demo mode without crashing', async () => {
    for (const path of ['/limits', '/projects', '/sessions', '/models', '/activity', '/settings']) {
      window.history.replaceState(null, '', `/?demo#${path}`);
      const { unmount } = render(<App />);
      expect(screen.getAllByRole('heading', { level: 1 }).some((h) => h.textContent === resolveRoute(parseHash('#' + path)).title)).toBe(true);
      unmount();
    }
  });
});

describe('resolveRoute', () => {
  it('maps paths to pages', () => {
    expect(resolveRoute(parseHash('#/')).title).toBe('Overview');
    expect(resolveRoute(parseHash('#/limits')).title).toBe('Limits');
    expect(resolveRoute(parseHash('#/sessions?project=x')).title).toBe('Sessions');
    expect(resolveRoute(parseHash('#/sessions/abc')).title).toBe('Session');
    expect(resolveRoute(parseHash('#/settings')).title).toBe('Settings');
    expect(resolveRoute(parseHash('#/nope')).title).toBe('Not found');
  });
});
