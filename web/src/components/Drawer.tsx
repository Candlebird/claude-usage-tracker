import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './icons';

export interface DrawerProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  /** Right side on desktop; always a bottom sheet on phones. */
  width?: number;
}

/** Side panel for details. Escape and the scrim close it; focus moves into it on open. */
export function Drawer({ open, onClose, title, children, width = 440 }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Parents often pass a fresh closure each render; reading it through a ref keeps
  // the effect below tied to `open` only, so re-renders never move focus.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      else if (e.key === 'Tab' && panel.current) trapTab(e, panel.current);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="drawer-root">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} ref={panel} style={{ ['--drawer-w' as string]: `${width}px` }}>
        <header className="drawer-head">
          <h2 className="drawer-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab / Shift+Tab cycling inside the dialog (it is aria-modal). */
function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (items.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  if (e.shiftKey && (active === first || active === root || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}
