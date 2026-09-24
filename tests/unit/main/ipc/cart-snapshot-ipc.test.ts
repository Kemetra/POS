import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';

/**
 * V5 active cart read — `cart:snapshot` IPC boundary. Malformed payloads
 * refuse generically (never echoing the failing field) and never reach the
 * handler; a valid payload forwards ONLY `cart_id`, so a renderer cannot
 * smuggle tenant/branch/terminal/operator/session identity into the read.
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function wire(): {
  invoke: (payload: unknown) => Promise<unknown>;
  snapshot: ReturnType<typeof vi.fn>;
} {
  const channels = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, fn: Handler) => {
      channels.set(channel, fn);
    },
  } as unknown as IpcMain;
  const bridge = new CartBridgeHandlers({
    getCurrentSession: () => null,
    getTerminalId: () => null,
  });
  const snapshot = vi
    .spyOn(bridge, 'snapshot')
    .mockResolvedValue({ kind: 'refused', reason: 'no_session' });
  registerCartHandlers(ipcMain, { handlers: bridge });
  const handler = channels.get(CART_IPC_CHANNELS.SNAPSHOT);
  if (handler === undefined) throw new Error('cart:snapshot not registered');
  return {
    invoke: (payload) => Promise.resolve(handler({} as IpcMainInvokeEvent, payload)),
    snapshot,
  };
}

describe('cart:snapshot IPC', () => {
  it('uses its own channel name', () => {
    expect(CART_IPC_CHANNELS.SNAPSHOT).toBe('cart:snapshot');
  });

  it.each([[null], [undefined], ['cart-1'], [{}], [{ cart_id: 42 }], [{ cart_id: '' }]])(
    'refuses malformed payload %j generically without calling the handler',
    async (payload) => {
      const w = wire();
      expect(await w.invoke(payload)).toEqual({ kind: 'refused', reason: 'no_session' });
      expect(w.snapshot).not.toHaveBeenCalled();
    },
  );

  it('forwards only cart_id, dropping any renderer-supplied identity', async () => {
    const w = wire();
    await w.invoke({
      cart_id: 'cart-1',
      tenant_id: 'evil-tenant',
      branch_id: 'evil-branch',
      operator_session_id: 'evil-session',
      owning_operator_id: 'evil-op',
    });
    expect(w.snapshot).toHaveBeenCalledOnce();
    expect(w.snapshot).toHaveBeenCalledWith({ cart_id: 'cart-1' });
  });
});
