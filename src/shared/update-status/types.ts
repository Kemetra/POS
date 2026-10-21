/**
 * RT-322 (S-B) — the update status bridge contract.
 *
 * Two channels: `updateStatus:get` (invoke, `{}` only) and `updateStatus:changed`
 * (push, main → renderer). Both carry one `UpdateStatusSnapshot`: a closed-set
 * state, an optional version string, optional closed-set blockers and an
 * optional short machine code. Never a path, URL, feed origin, channel, error
 * text or stack. The surface is read-only: no install trigger, no channel or
 * origin setter.
 *
 * `UPDATE_STATUS_STATES` mirrors main's `UPDATE_STATES` and
 * `UPDATE_STATUS_BLOCKERS` mirrors `SafePointBlocker`; a test keeps them equal.
 */

export const UPDATE_STATUS_IPC_CHANNELS = {
  GET: 'updateStatus:get',
  CHANGED: 'updateStatus:changed',
} as const;

export const UPDATE_STATUS_STATES = [
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
export type UpdateStatusState = (typeof UPDATE_STATUS_STATES)[number];

export const UPDATE_STATUS_BLOCKERS = [
  'open_shift',
  'open_cart',
  'payment_in_flight',
  'return_in_flight',
  'print_in_progress',
  'unreadable',
] as const;
export type UpdateStatusBlocker = (typeof UPDATE_STATUS_BLOCKERS)[number];

export interface UpdateStatusSnapshot {
  readonly v: 1;
  readonly state: UpdateStatusState;
  /** A short machine code (`^[a-z][a-z0-9_]{0,39}$`); never free text. */
  readonly detail?: string;
  /** A plain version such as `1.4.2` or `1.4.2-lab.1`. */
  readonly availableVersion?: string;
  readonly blockers?: readonly UpdateStatusBlocker[];
}

/** `updateStatus:get` with anything but `{}` (INP-1). */
export const UPDATE_STATUS_INVALID = { kind: 'refused', reason: 'invalid_input' } as const;
export type UpdateStatusInvalid = typeof UPDATE_STATUS_INVALID;

const STATES: ReadonlySet<string> = new Set(UPDATE_STATUS_STATES);
const BLOCKERS: ReadonlySet<string> = new Set(UPDATE_STATUS_BLOCKERS);
const DETAIL_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/;

export function isUpdateStatusState(value: unknown): value is UpdateStatusState {
  return typeof value === 'string' && STATES.has(value);
}

export function isUpdateStatusBlocker(value: unknown): value is UpdateStatusBlocker {
  return typeof value === 'string' && BLOCKERS.has(value);
}

export function isDetailCode(value: unknown): value is string {
  return typeof value === 'string' && DETAIL_CODE.test(value);
}

export function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}
