import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('Activity page (demo)', () => {
  it('renders both heatmaps, KPIs and live requests', async () => {
    window.history.replaceState(null, '', '/?demo#/activity');
    const { container } = render(<App />);
    expect(await screen.findByText('When you work', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Daily activity')).toBeInTheDocument();
    expect(screen.getByText('Busiest hour')).toBeInTheDocument();
    expect(await screen.findByText('Live requests', {}, { timeout: 4000 })).toBeInTheDocument();

    // 7 x 24 hour cells plus the calendar days (12 weeks, last one may be partial).
    expect(container.querySelectorAll('.act-hour-grid .act-cell')).toHaveLength(168);
    const days = container.querySelectorAll('.act-cal .act-cell:not(.act-cell-pad)');
    expect(days.length).toBe(84);
    expect(container.querySelectorAll('.act-cal .act-cell[data-level]:not([data-level="0"])').length).toBeGreaterThan(0);

    // Tapping a cell shows its value in the readout.
    fireEvent.click(container.querySelector('.act-hour-grid .act-cell')!);
    expect(screen.getByText(/^Mon 00:00: /)).toBeInTheDocument();

    // Switching the metric relabels the cards.
    fireEvent.click(screen.getByRole('radio', { name: 'Requests' }));
    expect(screen.getByText('Requests by weekday and hour')).toBeInTheDocument();
  });
});
