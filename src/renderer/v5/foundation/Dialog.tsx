import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
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

/** A same-name radio group contributes one tab stop: the first radio seen for that name. */
function keepsStop(el: HTMLElement, seenGroups: Set<string>): boolean {
  if (!isNamedRadio(el)) return true;
  if (seenGroups.has(el.name)) return false;
  seenGroups.add(el.name);
  return true;
}

/** The stop that stands for `el`: a radio group's checked radio, else `el` itself. */
function groupStop(items: HTMLElement[], el: HTMLElement): HTMLElement {
  if (!isNamedRadio(el)) return el;
  return items.find((item) => isCheckedRadioOf(item, el.name)) ?? el;
}

function isCheckedRadioOf(item: Element, name: string): boolean {
  return isNamedRadio(item) && item.name === name && item.checked;
}

/**
 * Tab stops in order. A same-name radio group is ONE stop, as in the browser:
 * its checked radio, else its first. (The manager-approval dialog opens with a
 * radio group; without this, Shift+Tab from a checked radio that is not the
 * first one walked out of the dialog.)
 */
function tabStops(panel: HTMLElement): HTMLElement[] {
  const items = focusableIn(panel);
  const seenGroups = new Set<string>();
  return items.filter((el) => keepsStop(el, seenGroups)).map((el) => groupStop(items, el));
}

/** Is focus on this stop? Any radio of a group stands on the group's stop. */
function isOnStop(active: Element | null, stop: HTMLElement): boolean {
  if (active === stop) return true;
  return isNamedRadio(active) && isNamedRadio(stop) && active.name === stop.name;
}

/**
 * Where Tab must wrap to, or null when focus is not at an edge (the browser's
 * own Tab then stays inside the panel). With no tab stop, the panel itself.
 */
function wrapTarget(panel: HTMLElement, backwards: boolean): HTMLElement | null {
  const stops = tabStops(panel);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) return panel;
  const [edge, wrap] = backwards ? [first, last] : [last, first];
  const active = document.activeElement;
  return active === panel || isOnStop(active, edge) ? wrap : null;
}

function trapTab(event: ReactKeyboardEvent<HTMLDivElement>, panel: HTMLElement | null): void {
  if (panel === null) return;
  const target = wrapTarget(panel, event.shiftKey);
  if (target === null) return;
  event.preventDefault();
  target.focus();
}

/** Esc stops at the dialog either way, so a listener behind it never acts on it. */
function containEscape(event: ReactKeyboardEvent<HTMLDivElement>, onCancel?: () => void): void {
  event.preventDefault();
  event.stopPropagation();
  onCancel?.();
}

/** A press on the backdrop itself must not move focus out of the dialog. */
function keepFocusOnBackdropPress(event: ReactMouseEvent<HTMLDivElement>): void {
  if (event.target === event.currentTarget) event.preventDefault();
}

/**
 * Focus the safe control on open (or the panel, when it cannot take focus) and
 * return focus to the invoker on close unless the caller routes it.
 */
function useDialogFocus(
  panelRef: RefObject<HTMLDivElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  restoreFocus: boolean,
): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocusRef.current ?? panelRef.current)?.focus();
    // A safe control that cannot take focus (disabled, hidden) must not leave
    // focus outside the dialog: fall back to the panel itself.
    if (panelRef.current?.contains(document.activeElement) !== true) panelRef.current?.focus();
    return () => {
      if (restoreFocus && opener?.isConnected === true) opener.focus();
    };
  }, [panelRef, initialFocusRef, restoreFocus]);
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
  useDialogFocus(panelRef, initialFocusRef, restoreFocus);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') trapTab(event, panelRef.current);
    else if (event.key === 'Escape') containEscape(event, onCancel);
  };

  return createPortal(
    <div className="v5-dialog-backdrop" dir="rtl" lang="ar" onMouseDown={keepFocusOnBackdropPress}>
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
