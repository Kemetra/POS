import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';

/**
 * §A4 review: identifiers on `cart:snapshot` and `cart:cancelPostHandoff` are
 * bounded (1–128 chars of [A-Za-z0-9_-]) before any handler runs, so a
 * renderer cannot bloat the audit log or smuggle path/markup-shaped values.
 * Prototype-pollution keys are inert: validators copy named fields only.
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function wire(): {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  snapshot: ReturnType<typeof vi.fn>;
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
  const snapshot = vi
    .spyOn(bridge, 'snapshot')
    .mockResolvedValue({ kind: 'refused', reason: 'no_session' });
  const cancel = vi.spyOn(bridge, 'cancelPostHandoff').mockResolvedValue({ kind: 'ok' });
  registerCartHandlers(ipcMain, { handlers: bridge });
  return {
    invoke: (channel, payload) => {
      const handler = channels.get(channel);
      if (handler === undefined) throw new Error(`${channel} not registered`);
      return Promise.resolve(handler({} as IpcMainInvokeEvent, payload));
    },
    snapshot,
    cancel,
  };
}

const TOO_LONG = 'a'.repeat(129);
const BAD_IDS = [TOO_LONG, 'has space', '../etc/passwd', '<script>', 'id\n2', 'ك'];
const OK = { cart_id: 'cart-1', handoff_action_id: 'handoff-1', idempotency_key: 'key-1' };

describe('cart IPC identifier bounds', () => {
  it.each(BAD_IDS)('snapshot refuses cart_id %j without calling the handler', async (bad) => {
    const w = wire();
    expect(await w.invoke(CART_IPC_CHANNELS.SNAPSHOT, { cart_id: bad })).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    expect(w.snapshot).not.toHaveBeenCalled();
  });

  it.each(
    BAD_IDS.flatMap((bad) =>
      (['cart_id', 'handoff_action_id', 'idempotency_key'] as const).map(
        (field) => [field, bad] as const,
      ),
    ),
  )('cancelPostHandoff refuses %s = %j without calling the handler', async (field, bad) => {
    const w = wire();
    expect(await w.invoke(CART_IPC_CHANNELS.CANCEL_POST_HANDOFF, { ...OK, [field]: bad })).toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('accepts a 128-character UUID-style id', async () => {
    const w = wire();
    const id = 'a'.repeat(92) + '-' + '0123456789abcdef0123456789abcde'.padEnd(35, 'f');
    expect(id).toHaveLength(128);
    await w.invoke(CART_IPC_CHANNELS.CANCEL_POST_HANDOFF, { ...OK, idempotency_key: id });
    expect(w.cancel).toHaveBeenCalledWith({ ...OK, idempotency_key: id });
  });

  it('ignores a __proto__ key: the forwarded request has only the named fields', async () => {
    const w = wire();
    const payload = JSON.parse(
      '{"cart_id":"cart-1","handoff_action_id":"handoff-1","idempotency_key":"key-1","__proto__":{"role":"admin"}}',
    ) as unknown;
    await w.invoke(CART_IPC_CHANNELS.CANCEL_POST_HANDOFF, payload);
    const forwarded = w.cancel.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(forwarded).sort()).toEqual([
      'cart_id',
      'handoff_action_id',
      'idempotency_key',
    ]);
    expect(Object.getPrototypeOf(forwarded)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['role']).toBeUndefined();
  });
});
