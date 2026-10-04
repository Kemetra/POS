import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';

/**
 * RT-26 — `cart:returnToSale` IPC boundary. Same posture as
 * `cart:cancelPostHandoff`: malformed or oversized identifiers refuse
 * generically and never reach the handler; a valid payload forwards ONLY
 * cart_id + handoff_action_id + idempotency_key (no renderer-supplied scope,
 * session or payment state).
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function wire(): {
  invoke: (payload: unknown) => Promise<unknown>;
  returnToSale: ReturnType<typeof vi.fn>;
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
  const returnToSale = vi.spyOn(bridge, 'returnToSale').mockResolvedValue({ kind: 'ok' });
  registerCartHandlers(ipcMain, { handlers: bridge });
  const handler = channels.get(CART_IPC_CHANNELS.RETURN_TO_SALE);
  if (handler === undefined) throw new Error('cart:returnToSale not registered');
  return {
    invoke: (payload) => Promise.resolve(handler({} as IpcMainInvokeEvent, payload)),
    returnToSale,
  };
}

const VALID = { cart_id: 'cart-1', handoff_action_id: 'handoff-1', idempotency_key: 'key-1' };

describe('cart:returnToSale IPC', () => {
  it('uses its own channel name', () => {
    expect(CART_IPC_CHANNELS.RETURN_TO_SALE).toBe('cart:returnToSale');
  });

  it.each([
    [null],
    [undefined],
    ['cart-1'],
    [{}],
    [{ ...VALID, cart_id: 42 }],
    [{ ...VALID, cart_id: '' }],
    [{ ...VALID, cart_id: 'x'.repeat(129) }],
    [{ ...VALID, cart_id: '../etc' }],
    [{ ...VALID, handoff_action_id: undefined }],
    [{ ...VALID, handoff_action_id: '<b>' }],
    [{ ...VALID, idempotency_key: '' }],
    [{ cart_id: 'cart-1', handoff_action_id: 'handoff-1' }],
  ])('refuses malformed payload %j generically without calling the handler', async (payload) => {
    const w = wire();
    expect(await w.invoke(payload)).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(w.returnToSale).not.toHaveBeenCalled();
  });

  it('forwards only the three request fields', async () => {
    const w = wire();
    await w.invoke({
      ...VALID,
      tenant_id: 'evil-tenant',
      operator_session_id: 'evil-session',
      payment_state: 'none',
    });
    expect(w.returnToSale).toHaveBeenCalledOnce();
    expect(w.returnToSale).toHaveBeenCalledWith(VALID);
  });
});
