import { useEffect, type JSX } from 'react';

import {
  createScanGuard,
  type ScanGuard,
  type ScanOwner,
  type RefuseSurface,
} from './scan-guard.js';
import type { RefuseKind } from './scan-messages.js';
import { useScanNoticeStore } from './scan-notice-store.js';
import './scan-notice.css';

/**
 * RT-239 (VNext A2) — wires the scan guard to the real window.
 *
 * The guard is a process-wide singleton: the scan owner (the Sale screen), the
 * protected surfaces (the PIN pad) and the listener live in unrelated parts of
 * the tree, so a React context would add plumbing without adding isolation.
 */

/** How long a refusal stays on screen. Long enough to read, short enough not to linger. */
export const SCAN_NOTICE_MS = 6000;

/** A modal dialog is open (`aria-modal="true"`). Non-modal popovers do not suspend scanning. */
function hasOpenModalDialog(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

let guard: ScanGuard | null = null;

export function getScanGuard(): ScanGuard {
  guard ??= createScanGuard({
    activeElement: () => document.activeElement,
    hasOpenDialog: hasOpenModalDialog,
    notify: (message) => {
      useScanNoticeStore.getState().show(message);
    },
  });
  return guard;
}

/** Test seam: drop the singleton so each test starts with no owner and no surfaces. */
export function resetScanGuardForTests(): void {
  guard = null;
  useScanNoticeStore.setState({ message: null, seq: 0 });
}

/** Register the screen that receives scans. One owner at a time; the latest wins. */
export function useScanOwner(owner: ScanOwner): void {
  useEffect(() => getScanGuard().setOwner(owner), [owner]);
}

/** Register a protected surface that has no input element (the PIN pad). */
export function useRefuseSurface(kind: RefuseKind, surface: RefuseSurface): void {
  useEffect(() => getScanGuard().registerSurface(kind, surface), [kind, surface]);
}

/** Installs the window listener once, and renders the notice. Mount at the app root. */
export function ScanGuardHost(): JSX.Element | null {
  const message = useScanNoticeStore((s) => s.message);
  const seq = useScanNoticeStore((s) => s.seq);

  useEffect(() => {
    const active = getScanGuard();
    const onKeyDown = (event: KeyboardEvent): void => {
      active.handleKeyDown(event);
    };
    // Capture phase: runs before React's root listeners and before any
    // `window` bubble listener (the PIN pad's), so a claimed Enter never reaches them.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (message === null) return undefined;
    const timer = setTimeout(() => {
      useScanNoticeStore.getState().clear();
    }, SCAN_NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [message, seq]);

  if (message === null) return null;
  return (
    <div
      className="scan-notice"
      role="status"
      aria-live="polite"
      data-testid="scan-notice"
      dir="rtl"
      lang="ar"
    >
      <span aria-hidden="true" className="scan-notice__icon">
        !
      </span>
      <span className="scan-notice__text">{message}</span>
    </div>
  );
}
