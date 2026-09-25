import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';

/**
 * `cart:cancelPostHandoff` IPC boundary. Malformed payloads refuse generically
 * (never echoing the failing field) and never reach the handler. A valid
 * payload forwards ONLY cart_id + handoff_action_id + idempotency_key: a
 * renderer cannot supply `attribution_operator_id`, so a cashier session can
 * never borrow a manager's authority through this bridge.
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function wire(): {
  invoke: (payload: unknown) => Promise<unknown>;
  cancel: ReturnType<typeof vi.fn>;
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
  const cancel = vi.spyOn(bridge, 'cancelPostHandoff').mockResolvedValue({ kind: 'ok' });
  registerCartHandlers(ipcMain, { handlers: bridge });
  const handler = channels.get(CART_IPC_CHANNELS.CANCEL_POST_HANDOFF);
  if (handler === undefined) throw new Error('cart:cancelPostHandoff not registered');
  return {
    invoke: (payload) => Promise.resolve(handler({} as IpcMainInvokeEvent, payload)),
    cancel,
  };
}

const VALID = { cart_id: 'cart-1', handoff_action_id: 'handoff-1', idempotency_key: 'key-1' };

describe('cart:cancelPostHandoff IPC', () => {
  it('uses its own channel name', () => {
    expect(CART_IPC_CHANNELS.CANCEL_POST_HANDOFF).toBe('cart:cancelPostHandoff');
  });

  it.each([
    [null],
    [undefined],
    ['cart-1'],
    [{}],
    [{ ...VALID, cart_id: 42 }],
    [{ ...VALID, cart_id: '' }],
    [{ ...VALID, handoff_action_id: undefined }],
    [{ ...VALID, handoff_action_id: '' }],
    [{ ...VALID, handoff_action_id: 7 }],
    [{ ...VALID, idempotency_key: '' }],
    [{ cart_id: 'cart-1', handoff_action_id: 'handoff-1' }],
  ])('refuses malformed payload %j generically without calling the handler', async (payload) => {
    const w = wire();
    expect(await w.invoke(payload)).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('forwards only the three request fields, dropping attribution and identity', async () => {
    const w = wire();
    await w.invoke({
      ...VALID,
      attribution_operator_id: 'mgr-borrowed',
      tenant_id: 'evil-tenant',
      operator_session_id: 'evil-session',
    });
    expect(w.cancel).toHaveBeenCalledOnce();
    expect(w.cancel).toHaveBeenCalledWith(VALID);
  });
});
