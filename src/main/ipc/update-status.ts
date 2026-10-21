/**
 * RT-322 (S-B) — `updateStatus:get` IPC registration, the status sanitizer and
 * the change push (design `2026-10-09-rt-234-pos-delivery-update-design.md` §6).
 *
 * One read-only invoke. It accepts exactly `{}` (INP-1); anything else gets
 * `INVALID` and never reaches the reader. There is no install trigger and no
 * channel or origin setter on this surface. Registered on the guarded ipcMain
 * (sender guard); it answers `idle` while the updater is disabled (unpackaged,
 * no origin), which is true: nothing is happening.
 *
 * What leaves main is rebuilt from known fields only: the closed-set state and
 * a plain version. The service's `detail` (an error message can carry a path or
 * the feed origin) and its blockers are never sent.
 */
import type { IpcMain } from 'electron';

import {
  UPDATE_STATUS_INVALID,
  UPDATE_STATUS_IPC_CHANNELS,
  isUpdateStatusState,
  isVersionString,
  type UpdateStatusInvalid,
  type UpdateStatusSnapshot,
} from '../../shared/update-status/types.js';
import type { UpdateStatus } from '../update/update-types.js';

export interface UpdateStatusHandlerDeps {
  read: () => UpdateStatus;
}

/** The status as the renderer may see it. Unknown states read as `error`. */
export function sanitizeUpdateStatus(status: UpdateStatus): UpdateStatusSnapshot {
  const { availableVersion } = status;
  return {
    v: 1,
    state: isUpdateStatusState(status.state) ? status.state : 'error',
    ...(isVersionString(availableVersion) ? { availableVersion } : {}),
  };
}

/** A plain object with no own keys — nothing else is a valid request. */
function isEmptyObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).length === 0;
}

export function registerUpdateStatusHandlers(
  ipcMain: IpcMain,
  deps: UpdateStatusHandlerDeps,
): void {
  ipcMain.handle(
    UPDATE_STATUS_IPC_CHANNELS.GET,
    (_event, ...args: unknown[]): UpdateStatusSnapshot | UpdateStatusInvalid =>
      args.length === 1 && isEmptyObject(args[0])
        ? sanitizeUpdateStatus(deps.read())
        : UPDATE_STATUS_INVALID,
  );
}

export interface UpdateStatusPushDeps {
  subscribe: (listener: (status: UpdateStatus) => void) => () => void;
  send: (snapshot: UpdateStatusSnapshot) => void;
}

/**
 * Pushes each distinct sanitized status to the windows. A send that throws
 * (a window closing) never reaches the updater that reported the change.
 */
export function wireUpdateStatusPush(deps: UpdateStatusPushDeps): () => void {
  let last: string | null = null;
  return deps.subscribe((status) => {
    const snapshot = sanitizeUpdateStatus(status);
    const key = JSON.stringify(snapshot);
    if (key === last) return;
    last = key;
    try {
      deps.send(snapshot);
    } catch {
      // The next change reaches the windows still open.
    }
  });
}
