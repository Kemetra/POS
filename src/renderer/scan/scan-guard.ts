import { extendRun, finishRun, isScanChar, type RunState } from './burst-detector.js';
import {
  asTextField,
  refuseKindOf,
  scanTargetOf,
  setFieldValue,
  type ScanField,
} from './scan-fields.js';
import {
  SCAN_DIALOG_OPEN_MESSAGE,
  SCAN_REFUSED_MESSAGE,
  SCAN_UNAVAILABLE_MESSAGE,
  type RefuseKind,
} from './scan-messages.js';

/**
 * RT-239 (VNext A2) — the scan guard.
 *
 * One window-level listener decides at the terminating Enter, not at the first
 * character. Printable keys on a button, a row control or the page body do
 * nothing; typed into a text field they are undoable. The damage a scan does is
 * its final Enter (it presses the focused `حذف`, or tenders), so that is the only
 * key intercepted, and human typing pays no latency. The Enter is claimed
 * (`preventDefault` + `stopImmediatePropagation`) and then routed:
 *
 *   1. a money / PIN / card-reference field  → restore it, notice M-S5;
 *   2. a modal dialog is open                 → restore the field, notice M-S6;
 *   3. a button, row, the page body, the search or a note field → restore the
 *      field (the search field is cleared) and hand the code to the scan owner;
 *   4. any other text field                   → not claimed at all (see `judge`).
 *
 * Everything the guard needs from the browser arrives through `ScanGuardDeps`
 * and the event it is handed, so it is tested without a window.
 */

/** The slice of a keydown event the guard uses. */
export interface GuardKeyEvent {
  readonly key: string;
  readonly timeStamp: number;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

export interface ScanGuardDeps {
  activeElement(): Element | null;
  hasOpenDialog(): boolean;
  notify(message: string): void;
}

export type ScanOwner = (code: string) => void;

/** A protected surface with no input element (the PIN pad listens on `window`). */
export interface RefuseSurface {
  snapshot(): string;
  restore(value: string): void;
}

export interface ScanGuard {
  handleKeyDown(event: GuardKeyEvent): void;
  /** Register the single scan owner. Returns an unregister that ignores a replaced owner. */
  setOwner(owner: ScanOwner): () => void;
  registerSurface(kind: RefuseKind, surface: RefuseSurface): () => void;
}

interface FieldSnapshot {
  readonly field: ScanField;
  readonly value: string;
}

interface SurfaceSnapshot {
  readonly kind: RefuseKind;
  readonly surface: RefuseSurface;
  readonly value: string;
}

interface RunSnapshot {
  readonly field: FieldSnapshot | null;
  readonly surfaces: readonly SurfaceSnapshot[];
}

const EMPTY_SNAPSHOT: RunSnapshot = { field: null, surfaces: [] };

type SurfaceRegistry = Map<symbol, { kind: RefuseKind; surface: RefuseSurface }>;

/** What the focused field and every protected surface held when a run started. */
function takeSnapshot(active: Element | null, surfaces: SurfaceRegistry): RunSnapshot {
  const field = asTextField(active);
  return {
    field: field === null ? null : { field, value: field.value },
    surfaces: [...surfaces.values()].map((s) => ({ ...s, value: s.surface.snapshot() })),
  };
}

/** Put every captured value back. The search field is cleared rather than restored. */
function restoreAll(snap: RunSnapshot, clearField: boolean): void {
  if (snap.field !== null) setFieldValue(snap.field.field, clearField ? '' : snap.field.value);
  for (const s of snap.surfaces) s.surface.restore(s.value);
}

/** The protected kind the burst landed in: the focused field first, then a registered surface. */
function protectedKind(snap: RunSnapshot): RefuseKind | null {
  if (snap.field !== null) {
    const kind = refuseKindOf(snap.field.field);
    if (kind !== null) return kind;
  }
  return snap.surfaces[0]?.kind ?? null;
}

type Verdict =
  | { readonly action: 'pass' }
  | { readonly action: 'refuse'; readonly message: string }
  | { readonly action: 'route'; readonly clearField: boolean };

/**
 * What a burst means where it landed. A protected field or an open dialog
 * refuses it; the search field and note fields hand it to the scan owner. Any
 * OTHER text field (a sale-number lookup, the pairing code, a diagnostics
 * search) is not the guard's business: it is left exactly as it was, so a
 * screen that already takes a scanned code keeps working.
 */
function judge(snap: RunSnapshot, dialogOpen: boolean): Verdict {
  const kind = protectedKind(snap);
  if (kind !== null) return { action: 'refuse', message: SCAN_REFUSED_MESSAGE[kind] };
  if (dialogOpen) return { action: 'refuse', message: SCAN_DIALOG_OPEN_MESSAGE };
  const field = snap.field?.field ?? null;
  const target = field === null ? null : scanTargetOf(field);
  if (field !== null && target === null) return { action: 'pass' };
  return { action: 'route', clearField: target === 'search' };
}

export function createScanGuard(deps: ScanGuardDeps): ScanGuard {
  let run: RunState = null;
  let snapshot: RunSnapshot = EMPTY_SNAPSHOT;
  let owner: ScanOwner | null = null;
  const surfaces: SurfaceRegistry = new Map();

  function reset(): void {
    run = null;
    snapshot = EMPTY_SNAPSHOT;
  }

  function refuse(snap: RunSnapshot, message: string): void {
    restoreAll(snap, false);
    deps.notify(message);
  }

  function route(code: string, snap: RunSnapshot, clearField: boolean): void {
    restoreAll(snap, clearField);
    if (owner === null) deps.notify(SCAN_UNAVAILABLE_MESSAGE);
    else owner(code);
  }

  function handleChar(event: GuardKeyEvent): void {
    const next = extendRun(run, event.key, event.timeStamp);
    run = next.run;
    if (next.started) snapshot = takeSnapshot(deps.activeElement(), surfaces);
  }

  function handleEnter(event: GuardKeyEvent): void {
    const code = finishRun(run, event.timeStamp);
    const snap = snapshot;
    reset();
    if (code === null) return;
    const verdict = judge(snap, deps.hasOpenDialog());
    if (verdict.action === 'pass') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (verdict.action === 'refuse') refuse(snap, verdict.message);
    else route(code, snap, verdict.clearField);
  }

  function handleKeyDown(event: GuardKeyEvent): void {
    // Shift is part of typing an upper-case code: it neither extends nor breaks a run.
    if (event.key === 'Shift') return;
    if (event.key === 'Enter') handleEnter(event);
    else if (isScanChar(event)) handleChar(event);
    else reset();
  }

  function setOwner(next: ScanOwner): () => void {
    owner = next;
    return () => {
      if (owner === next) owner = null;
    };
  }

  function registerSurface(kind: RefuseKind, surface: RefuseSurface): () => void {
    const id = Symbol('scan-surface');
    surfaces.set(id, { kind, surface });
    return () => {
      surfaces.delete(id);
    };
  }

  return { handleKeyDown, setOwner, registerSurface };
}
