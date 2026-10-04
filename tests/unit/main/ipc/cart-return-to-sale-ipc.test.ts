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

/**
 * Registers the real cart IPC on a fake `ipcMain`, stubs ONE handler method
 * with `stub`, and returns an invoker for `channel` plus that stub.
 */
function wireChannel<T>(
  channel: string,
  stub: (bridge: CartBridgeHandlers) => T,
): { invoke: (payload: unknown) => Promise<unknown>; spy: T } {
  const channels = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, fn: Handler) => {
      channels.set(name, fn);
    },
  } as unknown as IpcMain;
  const bridge = new CartBridgeHandlers({
    getCurrentSession: () => null,
    getTerminalId: () => null,
  });
  const spy = stub(bridge);
  registerCartHandlers(ipcMain, { handlers: bridge });
  const handler = channels.get(channel);
  if (handler === undefined) throw new Error(`${channel} not registered`);
  return {
    invoke: (payload) => Promise.resolve(handler({} as IpcMainInvokeEvent, payload)),
    spy,
  };
}

function wire() {
  const w = wireChannel(CART_IPC_CHANNELS.RETURN_TO_SALE, (bridge) =>
    vi.spyOn(bridge, 'returnToSale').mockResolvedValue({ kind: 'ok' }),
  );
  return { invoke: w.invoke, returnToSale: w.spy };
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

describe('cart:returnToSaleEligibility IPC (read-only)', () => {
  function wireEligibility() {
    const w = wireChannel(CART_IPC_CHANNELS.RETURN_TO_SALE_ELIGIBILITY, (bridge) =>
      vi
        .spyOn(bridge, 'returnToSaleEligibility')
        .mockResolvedValue({ kind: 'ok', returnable: true }),
    );
    return { invoke: w.invoke, eligibility: w.spy };
  }

  const REF = { cart_id: 'cart-1', handoff_action_id: 'handoff-1' };

  it('uses its own channel name', () => {
    expect(CART_IPC_CHANNELS.RETURN_TO_SALE_ELIGIBILITY).toBe('cart:returnToSaleEligibility');
  });

  it.each([
    [null],
    ['cart-1'],
    [{}],
    [{ ...REF, cart_id: 42 }],
    [{ ...REF, cart_id: '../etc' }],
    [{ ...REF, handoff_action_id: '' }],
    [{ cart_id: 'cart-1' }],
  ])('refuses malformed payload %j generically without calling the handler', async (payload) => {
    const w = wireEligibility();
    expect(await w.invoke(payload)).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(w.eligibility).not.toHaveBeenCalled();
  });

  it('forwards only cart_id + handoff_action_id', async () => {
    const w = wireEligibility();
    expect(await w.invoke({ ...REF, idempotency_key: 'k', tenant_id: 'evil' })).toEqual({
      kind: 'ok',
      returnable: true,
    });
    expect(w.eligibility).toHaveBeenCalledWith(REF);
  });
});
