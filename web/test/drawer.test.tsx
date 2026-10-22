import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawer } from '../src/components/Drawer';

afterEach(cleanup);

function View({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <>
      <button type="button">Row</button>
      <Drawer open={open} onClose={onClose} title="Details">
        <button type="button">Inner A</button>
        <button type="button">Inner B</button>
      </Drawer>
    </>
  );
}

describe('Drawer', () => {
  it('keeps focus in place when the parent re-renders with a new onClose', () => {
    const { rerender } = render(<View open onClose={() => {}} />);
    const inner = screen.getByRole('button', { name: 'Inner B' });
    inner.focus();
    rerender(<View open onClose={() => {}} />);
    expect(document.activeElement).toBe(inner);
  });

  it('moves focus in on open and back on close', () => {
    const { rerender } = render(<View open={false} onClose={() => {}} />);
    const row = screen.getByRole('button', { name: 'Row' });
    row.focus();
    rerender(<View open onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    rerender(<View open={false} onClose={() => {}} />);
    expect(document.activeElement).toBe(row);
  });

  it('calls the latest onClose on Escape', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<View open onClose={first} />);
    rerender(<View open onClose={latest} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it('wraps Tab inside the dialog', () => {
    render(<View open onClose={() => {}} />);
    const last = screen.getByRole('button', { name: 'Inner B' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
