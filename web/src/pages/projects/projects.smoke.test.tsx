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

describe('Projects page (demo)', () => {
  it('renders the KPIs, chart card and project table', async () => {
    window.history.replaceState(null, '', '/?demo#/projects');
    render(<App />);
    expect(await screen.findByText('All projects', {}, wait)).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /projects in the selected range/i }, wait);
    expect(within(table).getAllByText('orbit-api').length).toBeGreaterThan(0);
    expect(screen.getAllByText('API-equivalent cost').length).toBeGreaterThan(0);
    expect(screen.getByText('Cost by project')).toBeInTheDocument();
  });

  it('opens the project drawer from the table', async () => {
    window.history.replaceState(null, '', '/?demo#/projects');
    render(<App />);
    const table = await screen.findByRole('table', { name: /projects in the selected range/i }, wait);
    fireEvent.click(within(table).getAllByText('lumen-web')[0]!);
    expect(await screen.findByText('Top sessions', {}, wait)).toBeInTheDocument();
    expect(screen.getByText('Cost over time')).toBeInTheDocument();
    expect(window.location.hash).toContain('project=');
  });

  it('opens the drawer from the URL and lists sessions', async () => {
    window.history.replaceState(null, '', '/?demo#/projects?project=c%3A%2Fdev%2Forbit-api');
    render(<App />);
    expect(await screen.findByText('All sessions in this project', {}, wait)).toBeInTheDocument();
    const links = await screen.findAllByRole('link', { name: /\$/ }, wait);
    expect(links.some((a) => a.getAttribute('href')?.includes('#/sessions/'))).toBe(true);
  });
});
