import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from '../../App';

const wait = { timeout: 4000 };

beforeAll(() => {
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

describe('Sessions pages (demo)', () => {
  it('lists sessions with pagination and opens a session', async () => {
    window.history.replaceState(null, '', '/?demo#/sessions');
    render(<App />);
    expect(await screen.findByText(/Showing/, {}, wait)).toBeInTheDocument();
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(rows[0]!);
    expect(window.location.hash).toMatch(/#\/sessions\/./);
    expect(await screen.findByText('Untracked overhead', {}, wait)).toBeInTheDocument();
    expect(screen.getByText('Model mix')).toBeInTheDocument();
    expect(screen.getByText('Main vs subagent vs workflow')).toBeInTheDocument();
    expect(screen.getAllByText('API-equivalent cost').length).toBeGreaterThan(0);
  });

  it('sorts by cost through the query string', async () => {
    window.history.replaceState(null, '', '/?demo#/sessions?sort=cost&project=c%3A%2Fdev%2Forbit-api');
    render(<App />);
    expect(await screen.findByText(/Showing/, {}, wait)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Top cost' })).toBeChecked();
  });

  it('shows not found for an unknown session', async () => {
    window.history.replaceState(null, '', '/?demo#/sessions/not-a-real-session');
    render(<App />);
    expect(await screen.findByText('Session not found', {}, wait)).toBeInTheDocument();
    expect(screen.getByText('All sessions')).toBeInTheDocument();
  });
});
