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
 * RT-444 (RT-116 S3): sign-in and takeover confirm / cancel are served while
 * locked. They reach a session only through the §4 admission guard
 * (`session-admission.ts`), which refuses another operator while this
 * terminal holds unresolved payment and otherwise ends the locked session
 * (`superseded_at_lock`) before creating the new one. The branch roster is
 * served too: the cashier sign-in picks from it, and it shows only what the
 * signed-out sign-in screen shows. Sign-out stays refused (§2.2): ending a
 * locked session takes a credential.
 */

export const LOCKED_ALLOWED_CHANNELS: ReadonlySet<string> = new Set<string>([
  SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE,
  SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION,
  OPERATOR_IPC_CHANNELS.GET_CURRENT_SESSION,
  // Notify-only; the session manager ignores activity while locked.
  OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY,
  // RT-444 — through the §4 admission guard only.
  OPERATOR_IPC_CHANNELS.SIGN_IN,
  OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM,
  OPERATOR_IPC_CHANNELS.TAKEOVER_CANCEL,
  OPERATOR_IPC_CHANNELS.LIST_BRANCH_ROSTER,
  PAIRING_IPC_CHANNELS.GET_STATUS,
  'app:ping',
  'app:version',
  'app:log',
  'app:config',
  // RT-634 — renderer crash reports stay reportable while locked.
  'app:report-error',
]);

/** Thrown for a refused call while locked. Generic: never names the channel. */
export class SessionLockedError extends Error {
  constructor() {
    super('session_locked');
    this.name = 'SessionLockedError';
  }
}

type GuardableIpcMain = Pick<IpcMain, 'handle' | 'on'>;

/** True when `channel` must be refused right now (locked and not allowlisted). */
type ChannelRefusal = (channel: string) => boolean;

function guardHandle(ipcMain: IpcMain, isRefused: ChannelRefusal): GuardableIpcMain['handle'] {
  return (channel, listener) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (isRefused(channel)) throw new SessionLockedError();
      const fn = listener as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown;
      return await fn(event, ...args);
    });
  };
}

function guardOn(ipcMain: IpcMain, isRefused: ChannelRefusal): GuardableIpcMain['on'] {
  return (channel, listener) => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      // `.on` has no return channel — fail closed by dropping the event.
      if (isRefused(channel)) return;
      const fn = listener as (e: IpcMainEvent, ...a: unknown[]) => void;
      fn(event, ...args);
    });
    return ipcMain;
  };
}

/** Pass every other member through, bound to the real `ipcMain`. */
function forward(target: IpcMain, prop: string | symbol, receiver: unknown): unknown {
  const value: unknown = Reflect.get(target, prop, receiver);
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}

/**
 * Wrap an `IpcMain` so every `handle`/`on` refuses non-allowlisted channels
 * while `isLocked()` is true. The lock is re-read on every call.
 */
export function createSessionLockGuardedIpcMain(
  ipcMain: IpcMain,
  isLocked: () => boolean,
): IpcMain {
  const isRefused: ChannelRefusal = (channel) =>
    isLocked() && !LOCKED_ALLOWED_CHANNELS.has(channel);
  const overrides: GuardableIpcMain = {
    handle: guardHandle(ipcMain, isRefused),
    on: guardOn(ipcMain, isRefused),
  };

  return new Proxy(ipcMain, {
    get(target, prop, receiver): unknown {
      return prop === 'handle' || prop === 'on' ? overrides[prop] : forward(target, prop, receiver);
    },
  });
}
