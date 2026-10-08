import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import './foundation.css';
import './dialog.css';

/**
 * RT-241 (VNext W1-A) — the one v5 Dialog mechanism (freeze 15 §3, §4;
 * DESIGN.md Dialog rule). Every v5 modal renders through it:
 *
 * - **Modal.** `aria-modal="true"`; Tab and Shift+Tab wrap inside the panel; a
 *   press on the backdrop never takes focus out. The scan guard reads the same
 *   `aria-modal` flag, so an open dialog suspends scanning (M-S6).
 * - **Safe initial focus.** The caller names the control (`initialFocusRef`):
 *   the safe option, never a destructive confirm (F-22).
 * - **Esc.** Cancels when the caller allows it (`onCancel`). Either way the key
 *   stops at the dialog, so a listener behind it (Checkout's Esc = Back) never
 *   acts on it.
 * - **Focus return.** Back to the invoker on close, unless the caller routes
 *   focus itself (`restoreFocus={false}`, e.g. back to the scan owner).
 * - **Portal.** Into the `DialogHost` node inside the V5 frame, so the dialog
 *   keeps the frame's RTL/Arabic scope and tokens, sits inside the lock's inert
 *   and concealed subtree, and its backdrop covers the whole frame (nav
 *   included). The panel also declares `dir`/`lang` itself.
 */

const DialogHostContext = createContext<HTMLElement | null>(null);

/**
 * Provides the portal node for v5 dialogs. The node is created once and
 * attached in a layout effect, so it is in the document before any dialog's
 * mount effect moves focus into it.
 */
export function DialogHost({ children }: { children: ReactNode }): JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const node = document.createElement('div');
    node.className = 'v5-dialog-host';
    return node;
  });

  useLayoutEffect(() => {
    anchorRef.current?.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host]);

  return (
    <DialogHostContext.Provider value={host}>
      {children}
      <div ref={anchorRef} className="v5-dialog-anchor" />
    </DialogHostContext.Provider>
  );
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
}

function isNamedRadio(el: Element | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'radio' && el.name !== '';
}

/**
 * Tab stops in order. A same-name radio group is ONE stop, as in the browser:
 * its checked radio, else its first. (The manager-approval dialog opens with a
 * radio group; without this, Shift+Tab from a checked radio that is not the
 * first one walked out of the dialog.)
 */
function tabStops(panel: HTMLElement): HTMLElement[] {
  const items = focusableIn(panel);
  const groups = new Set<string>();
  const stops: HTMLElement[] = [];
  for (const el of items) {
    if (!isNamedRadio(el)) {
      stops.push(el);
      continue;
    }
    if (groups.has(el.name)) continue;
    groups.add(el.name);
    const group = items.filter((item) => isNamedRadio(item) && item.name === el.name);
    stops.push(group.find((radio) => (radio as HTMLInputElement).checked) ?? el);
  }
  return stops;
}

/** Is focus on this stop? Any radio of a group stands on the group's stop. */
function isOnStop(active: Element | null, stop: HTMLElement): boolean {
  if (active === stop) return true;
  return isNamedRadio(active) && isNamedRadio(stop) && active.name === stop.name;
}

/** Wraps Tab at the panel's edges. Returns true when it moved focus itself. */
function trapTab(panel: HTMLElement, backwards: boolean): boolean {
  const stops = tabStops(panel);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) {
    panel.focus();
    return true;
  }
  const active = document.activeElement;
  const atEdge = active === panel || isOnStop(active, backwards ? first : last);
  if (!atEdge) return false;
  (backwards ? last : first).focus();
  return true;
}

export interface DialogProps {
  /** Accessible name of the dialog. */
  label: string;
  /** Esc cancels when present. Omit when the dialog must not be cancelled now. */
  onCancel?: () => void;
  /** The control focused on open: the safe option. */
  initialFocusRef: RefObject<HTMLElement | null>;
  /** Return focus to the invoker on close. Off when the caller routes focus itself. */
  restoreFocus?: boolean;
  /** Id of the element that describes the dialog. */
  describedBy?: string;
  children: ReactNode;
}

export function Dialog({
  label,
  onCancel,
  initialFocusRef,
  restoreFocus = true,
  describedBy,
  children,
}: DialogProps): JSX.Element {
  const host = useContext(DialogHostContext);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocusRef.current ?? panelRef.current)?.focus();
    // A safe control that cannot take focus (disabled, hidden) must not leave
    // focus outside the dialog: fall back to the panel itself.
    if (panelRef.current?.contains(document.activeElement) !== true) panelRef.current?.focus();
    return () => {
      if (restoreFocus && opener?.isConnected === true) opener.focus();
    };
  }, [initialFocusRef, restoreFocus]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const panel = panelRef.current;
    if (event.key === 'Tab' && panel !== null) {
      if (trapTab(panel, event.shiftKey)) event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
    }
  };

  return createPortal(
    <div
      className="v5-dialog-backdrop"
      dir="rtl"
      lang="ar"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
        tabIndex={-1}
        className="v5-dialog v5-live-dialog"
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    host ?? document.body,
  );
}
