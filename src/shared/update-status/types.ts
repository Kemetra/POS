/**
 * RT-322 (S-B) — the update status bridge contract.
 *
 * Two channels: `updateStatus:get` (invoke, `{}` only) and `updateStatus:changed`
 * (push, main → renderer). Both carry one `UpdateStatusSnapshot`: a closed-set
 * state and an optional plain version. Never a path, URL, feed origin, channel,
 * error text, detail or stack. The surface is read-only: no install trigger, no channel or
 * origin setter.
 *
 * `UPDATE_STATUS_STATES` mirrors main's `UPDATE_STATES`; a test keeps them equal.
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

export interface UpdateStatusSnapshot {
  readonly v: 1;
  readonly state: UpdateStatusState;
  /** A plain version such as `1.4.2` or `1.4.2-lab.1`. */
  readonly availableVersion?: string;
}

/** `updateStatus:get` with anything but `{}` (INP-1). */
export const UPDATE_STATUS_INVALID = { kind: 'refused', reason: 'invalid_input' } as const;
export type UpdateStatusInvalid = typeof UPDATE_STATUS_INVALID;

const STATES: ReadonlySet<string> = new Set(UPDATE_STATUS_STATES);
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/;

export function isUpdateStatusState(value: unknown): value is UpdateStatusState {
  return typeof value === 'string' && STATES.has(value);
}

export function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}
