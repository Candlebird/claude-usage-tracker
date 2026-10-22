import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from '../../App';

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

describe('Models page (demo)', () => {
  it('renders KPIs, cache cards and the model table', async () => {
    window.history.replaceState(null, '', '/?demo#/models');
    render(<App />);
    expect(await screen.findByText('Cache hit rate', { selector: '.card-title' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Token mix', { selector: '.card-title' })).toBeInTheDocument();
    expect(screen.getByText('Cache writes: 5-minute vs 1-hour')).toBeInTheDocument();
    expect(await screen.findByText('Range average', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByText('1-hour TTL', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: /per-model usage/i }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getAllByText(/API-equivalent/i).length).toBeGreaterThan(0);
  });
});
