import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, loadTheme, resolveTheme, useTheme } from '../src/theme';

function Probe({ id }: { id: string }) {
  const t = useTheme();
  return (
    <button data-testid={id} onClick={t.toggle}>
      {t.choice}:{t.resolved}
    </button>
  );
}

afterEach(() => applyTheme('system'));

describe('theme', () => {
  it('persists explicit choices and clears system', () => {
    applyTheme('light');
    expect(loadTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme('system');
    expect(loadTheme()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('resolves system to dark when there is no preference', () => {
    expect(resolveTheme('system')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('keeps every useTheme caller in sync', () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    const before = screen.getByTestId('b').textContent;
    act(() => screen.getByTestId('a').click());
    const after = screen.getByTestId('b').textContent;
    expect(after).not.toBe(before);
    expect(screen.getByTestId('a').textContent).toBe(after);
  });
});
