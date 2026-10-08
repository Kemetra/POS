import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { createSaleBoundaryIpcMain, isSaleChannel } from '../sale-boundary-guard.js';
import { CART_IPC_CHANNELS } from '../../../shared/cart/channels.js';
import { PAYMENTS_IPC_CHANNELS, TENDER_IPC_CHANNELS } from '../../../shared/payments/channels.js';
import { OPERATOR_IPC_CHANNELS } from '../../../shared/operator/channels.js';

/**
 * RT-113 P2 (Codex P1, comment 4179617256) — ONE choke point re-checks a
 * latched session's safe point after EVERY sale call settles, instead of a
 * hook per cart handler that a new mutation could forget (the missed
 * remove-final-line hole). It wraps `ipcMain` at the composition root, so any
 * cart, payments or tender channel registered later is covered by default.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, Listener> } {
  const handlers = new Map<string, Listener>();
  const ipcMain = {
    handle: (channel: string, fn: Listener) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: vi.fn(),
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

const SALE_CHANNELS = [
  ...Object.values(CART_IPC_CHANNELS),
  ...Object.values(PAYMENTS_IPC_CHANNELS),
  ...Object.values(TENDER_IPC_CHANNELS),
];

describe('sale-boundary guard', () => {
  it.each(SALE_CHANNELS)(
    '%s re-checks the safe point after the handler settles',
    async (channel) => {
      const { ipcMain, handlers } = fakeIpcMain();
      const order: string[] = [];
      const guarded = createSaleBoundaryIpcMain(ipcMain, () => order.push('recheck'));
      guarded.handle(channel, () => {
        order.push('handler');
        return Promise.resolve({ kind: 'ok' });
      });
      const res = await handlers.get(channel)?.({} as IpcMainInvokeEvent, { x: 1 });
      expect(res).toEqual({ kind: 'ok' });
      expect(order).toEqual(['handler', 'recheck']);
    },
  );

  it('re-checks after a refusal and after a throwing handler too', async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const recheck = vi.fn();
    const guarded = createSaleBoundaryIpcMain(ipcMain, recheck);
    guarded.handle(CART_IPC_CHANNELS.LINES_ADD, () => ({ kind: 'refused', reason: 'frozen' }));
    guarded.handle(CART_IPC_CHANNELS.LINES_REMOVE, () => {
      throw new Error('boom');
    });
    await handlers.get(CART_IPC_CHANNELS.LINES_ADD)?.({} as IpcMainInvokeEvent);
    await expect(
      handlers.get(CART_IPC_CHANNELS.LINES_REMOVE)?.({} as IpcMainInvokeEvent),
    ).rejects.toThrow('boom');
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it('a throwing re-check never changes the sale call result', async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const guarded = createSaleBoundaryIpcMain(ipcMain, () => {
      throw new Error('recheck failed');
    });
    guarded.handle(CART_IPC_CHANNELS.CREATE, () => ({ kind: 'ok', cart_id: 'c1' }));
    await expect(
      Promise.resolve(handlers.get(CART_IPC_CHANNELS.CREATE)?.({} as IpcMainInvokeEvent)),
    ).resolves.toEqual({ kind: 'ok', cart_id: 'c1' });
  });

  it('non-sale channels are passed through untouched', async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const recheck = vi.fn();
    const guarded = createSaleBoundaryIpcMain(ipcMain, recheck);
    guarded.handle(OPERATOR_IPC_CHANNELS.SIGN_IN, () => 'signed');
    await expect(
      Promise.resolve(handlers.get(OPERATOR_IPC_CHANNELS.SIGN_IN)?.({} as IpcMainInvokeEvent)),
    ).resolves.toBe('signed');
    expect(recheck).not.toHaveBeenCalled();
    // Other members still reach the real ipcMain.
    guarded.on('x', vi.fn());
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(ipcMain.on).toHaveBeenCalled();
  });

  it('isSaleChannel covers cart, payments and tender only', () => {
    for (const c of SALE_CHANNELS) expect(isSaleChannel(c)).toBe(true);
    expect(isSaleChannel('operator:sign-in')).toBe(false);
    expect(isSaleChannel('catalogue:search')).toBe(false);
    expect(isSaleChannel('cartx:create')).toBe(false);
  });
});
