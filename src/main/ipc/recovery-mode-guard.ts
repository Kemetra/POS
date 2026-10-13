import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * RT-441 (RT-116 §5.1) — a session admitted in RECOVERY MODE (a manager or
 * admin clearing this terminal's stuck payment) may not sell. While the
 * session carries `recovery_of`, every `cart:*`, `payments:*`, `tender:*`,
 * `vouchers:*` and `returns:*` call is refused `recovery_mode` before its
 * handler runs; `recovery:*`, `approval:*` and the operator / app calls are
 * served. Enforced once at the composition root by wrapping `ipcMain` (the
 * `session-lock-guard.ts` pattern), so a handler registered later is covered.
 */

const SALE_NAMESPACES = ['cart:', 'payments:', 'tender:', 'vouchers:', 'returns:'];

export function isRefusedInRecoveryMode(channel: string): boolean {
  return SALE_NAMESPACES.some((prefix) => channel.startsWith(prefix));
}

/** Thrown for a refused call in recovery mode. Generic: never names the channel. */
export class RecoveryModeError extends Error {
  constructor() {
    super('recovery_mode');
    this.name = 'RecoveryModeError';
  }
}

/** Pass every other member through, bound to the real `ipcMain`. */
function forward(target: IpcMain, prop: string | symbol, receiver: unknown): unknown {
  const value: unknown = Reflect.get(target, prop, receiver);
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}

export function createRecoveryModeGuardedIpcMain(
  ipcMain: IpcMain,
  inRecoveryMode: () => boolean,
): IpcMain {
  const refused = (channel: string): boolean =>
    isRefusedInRecoveryMode(channel) && inRecoveryMode();
  const handle: IpcMain['handle'] = (channel, listener) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (refused(channel)) throw new RecoveryModeError();
      const fn = listener as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown;
      return await fn(event, ...args);
    });
  };
  const on: IpcMain['on'] = (channel, listener) => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (refused(channel)) return;
      const fn = listener as (e: IpcMainEvent, ...a: unknown[]) => void;
      fn(event, ...args);
    });
    return ipcMain;
  };
  return new Proxy(ipcMain, {
    get(target, prop, receiver): unknown {
      if (prop === 'handle') return handle;
      if (prop === 'on') return on;
      return forward(target, prop, receiver);
    },
  });
}
