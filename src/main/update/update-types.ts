/**
 * RT-772 slice 2 — shared vocabulary for the POS updater (ADR-0006, design
 * `docs/superpowers/specs/2026-10-09-rt-234-pos-delivery-update-design.md` §6, §9, §10).
 */

/** The update-state vocabulary (design §9). `compat_blocked` is reserved for the gated Phase 2 contract. */
export const UPDATE_STATES = [
  'idle',
  'checking',
  'downloading',
  'downloaded',
  'verify_failed',
  'verify_unavailable',
  'compat_blocked',
  'update_pending',
  'installing',
  'error',
] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

/** Per-terminal channel, set at provisioning and never editable at the cashier surface (design §10). */
export const UPDATE_CHANNELS = ['lab', 'canary', 'stable'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export type SafePointBlocker =
  | 'open_shift'
  | 'open_cart'
  | 'payment_in_flight'
  | 'return_in_flight'
  | 'print_in_progress'
  | 'unreadable';

export type SafePointVerdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly blockers: readonly SafePointBlocker[] };

/** One reader per fact the install predicate depends on. Each is re-read on every call. */
export interface SafePointInputs {
  hasOpenShift(): boolean;
  hasOpenCart(): boolean;
  hasNonTerminalPayment(): boolean;
  hasReturnInFlight(): boolean;
  isPrintInProgress(): boolean;
}

export interface UpdateStatus {
  readonly state: UpdateState;
  /** A short machine-readable reason (never a path, credential or business value). */
  readonly detail?: string;
  readonly availableVersion?: string;
  readonly blockers?: readonly SafePointBlocker[];
}
