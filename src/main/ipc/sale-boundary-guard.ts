import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/**
 * RT-113 P2 (Codex P1, PR #535 comment 4179617256) — the ONE choke point that
 * re-checks a latched session's safe point.
 *
 * A session that lost its authority (taken over elsewhere, account refused,
 * device revoked) is latched and must end at its FIRST safe point: no open
 * sale with lines and no live tender. Every way a sale changes (add, remove or
 * update a line, void, cancel, hand-off, return to sale, tender and payment
 * calls) goes through a `cart:*`, `payments:*` or `tender:*` IPC call. Wrapping
 * `ipcMain` at the composition root re-checks after EVERY such call settles,
 * whatever its result, so a handler added later is covered by default and no
 * individual mutation can be forgotten. The re-check is cheap and a no-op
 * while the session is not latched.
 *
 * The same pattern as `session-lock-guard.ts` / `sender-guard.ts`.
 */

const SALE_CHANNEL_PREFIXES = ['cart:', 'payments:', 'tender:'] as const;

/** True for the IPC channels that can change a sale. */
export function isSaleChannel(channel: string): boolean {
  return SALE_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

type InvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function wrapListener(listener: InvokeListener, onSaleCall: () => void): InvokeListener {
  return async (event, ...args) => {
    try {
      return await listener(event, ...args);
    } finally {
      try {
        onSaleCall();
      } catch {
        // A failing re-check must never change the sale call's result.
      }
    }
  };
}

/** Pass every other member through, bound to the real `ipcMain`. */
function forward(target: IpcMain, prop: string | symbol, receiver: unknown): unknown {
  const value: unknown = Reflect.get(target, prop, receiver);
  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}

/**
 * Wrap an `IpcMain` so every sale channel's `handle` listener calls
 * `onSaleCall` after it settles. Other channels and members pass through.
 */
export function createSaleBoundaryIpcMain(ipcMain: IpcMain, onSaleCall: () => void): IpcMain {
  const handle: IpcMain['handle'] = (channel, listener) => {
    const fn = listener as InvokeListener;
    ipcMain.handle(channel, isSaleChannel(channel) ? wrapListener(fn, onSaleCall) : fn);
  };
  return new Proxy(ipcMain, {
    get(target, prop, receiver): unknown {
      return prop === 'handle' ? handle : forward(target, prop, receiver);
    },
  });
}
