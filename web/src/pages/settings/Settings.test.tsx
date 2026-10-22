import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from '../../App';

beforeAll(() => {
  // Recharts' ResponsiveContainer (used elsewhere in the shell) needs ResizeObserver, which jsdom lacks.
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

function renderSettings() {
  window.history.replaceState(null, '', '/?demo#/settings');
  render(<App />);
}

describe('Settings & Health (demo)', () => {
  it('renders the health strip and every card', async () => {
    renderSettings();
    const strip = await screen.findByRole('list', { name: /system health/i }, { timeout: 3000 });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(4);
    expect(within(strip).getByRole('button', { name: /^sync: up to date/i })).toBeInTheDocument();

    for (const title of ['Sync', 'Cloudflare free tier', 'Data quality', 'Budget and alerts', 'API connection', 'Appearance']) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole('table', { name: /recent sync runs/i })).toBeInTheDocument();
    expect(screen.getByText(/synthetic demo data/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/daily budget \(usd, api-equivalent\)/i)).toHaveValue(60);
    expect(screen.getByText(/api-equivalent cost, not a bill/i)).toBeInTheDocument();
  });

  it('validates, saves a change and sends a demo test alert', async () => {
    renderSettings();
    const budget = await screen.findByLabelText(/daily budget/i, {}, { timeout: 3000 });

    fireEvent.change(screen.getByLabelText(/5-hour window/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /save alerts/i }));
    expect(await screen.findByText(/fix the highlighted fields/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/5-hour window/i)).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByLabelText(/5-hour window/i), { target: { value: '80, 95' } });
    fireEvent.change(budget, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /save alerts/i }));
    expect(await screen.findByText(/saved/i, { selector: '.form-status' })).toBeInTheDocument();
    expect(screen.getByLabelText(/5-hour window/i)).toHaveValue('80, 95');

    fireEvent.click(screen.getByRole('button', { name: /send test notification/i }));
    expect(await screen.findByText(/demo mode: nothing sent/i)).toBeInTheDocument();
  });
});
