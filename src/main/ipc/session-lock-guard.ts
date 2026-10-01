import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

import {
  OPERATOR_IPC_CHANNELS,
  SESSION_LOCK_IPC_CHANNELS,
} from '../../shared/operator/channels.js';
import { PAIRING_IPC_CHANNELS } from '../../shared/pairing-types.js';

/**
 * RT-117 (RT-116 §2.5) — locked-session IPC allowlist.
 *
 * While the operator session is LOCKED, main serves ONLY the channels below.
 * Every other channel is refused before its handler runs. This is enforced
 * once at the composition root by wrapping `ipcMain` (the same pattern as
 * `sender-guard.ts`), so a handler registered later is refused by default —
 * no registrar can forget the check.
 *
 * S1 scope: sign-in, takeover and sign-out are refused while locked, so
 * same-operator `unlock` is the only way back in until S3 adds the admission
 * guard (RT-116 §4).
 */

export const LOCKED_ALLOWED_CHANNELS: ReadonlySet<string> = new Set<string>([
  SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE,
  SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION,
  OPERATOR_IPC_CHANNELS.GET_CURRENT_SESSION,
  // Notify-only; the session manager ignores activity while locked.
  OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY,
  PAIRING_IPC_CHANNELS.GET_STATUS,
  'app:ping',
  'app:version',
  'app:log',
  'app:config',
]);

/** Thrown for a refused call while locked. Generic: never names the channel. */
export class SessionLockedError extends Error {
  constructor() {
    super('session_locked');
    this.name = 'SessionLockedError';
  }
}

type GuardableIpcMain = Pick<IpcMain, 'handle' | 'on'>;

/**
 * Wrap an `IpcMain` so every `handle`/`on` refuses non-allowlisted channels
 * while `isLocked()` is true. The lock is re-read on every call.
 */
export function createSessionLockGuardedIpcMain(
  ipcMain: IpcMain,
  isLocked: () => boolean,
): IpcMain {
  const overrides: GuardableIpcMain = {
    handle(channel, listener) {
      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (isLocked() && !LOCKED_ALLOWED_CHANNELS.has(channel)) {
          throw new SessionLockedError();
        }
        const fn = listener as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown;
        return await fn(event, ...args);
      });
    },
    on(channel, listener) {
      ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
        // `.on` has no return channel — fail closed by dropping the event.
        if (isLocked() && !LOCKED_ALLOWED_CHANNELS.has(channel)) return;
        const fn = listener as (e: IpcMainEvent, ...a: unknown[]) => void;
        fn(event, ...args);
      });
      return ipcMain;
    },
  };

  return new Proxy(ipcMain, {
    get(target, prop, receiver): unknown {
      if (prop === 'handle' || prop === 'on') {
        return overrides[prop];
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
