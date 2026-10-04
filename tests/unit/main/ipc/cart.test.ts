import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';

/**
 * Cart IPC registrar smoke. Verifies:
 *   - every cart channel gets registered exactly once
 *   - input validation refuses malformed payloads generically
 *     (`{ kind: 'refused', reason: 'no_session' }`) without echo
 *   - valid payloads forward to the underlying CartBridgeHandlers
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function mkIpc(): { ipcMain: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

function fakeEvent(): IpcMainInvokeEvent {
  return {} as IpcMainInvokeEvent;
}

describe('registerCartHandlers — channel registration', () => {
  it('registers all 10 cart channels', () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    registerCartHandlers(ipcMain, { handlers: bridge });
    for (const ch of Object.values(CART_IPC_CHANNELS)) {
      expect(handlers.has(ch)).toBe(true);
    }
    expect(handlers.size).toBe(Object.keys(CART_IPC_CHANNELS).length);
  });
});

describe('registerCartHandlers — input validation refusals', () => {
  it.each([
    [CART_IPC_CHANNELS.CREATE, {}],
    [CART_IPC_CHANNELS.CREATE, null],
    [CART_IPC_CHANNELS.LINES_ADD, { cart_id: 'c' }],
    [
      CART_IPC_CHANNELS.LINES_UPDATE,
      { cart_id: 'c', op: 'invalid', line_id: 'l', version: 1, idempotency_key: 'k' },
    ],
    [CART_IPC_CHANNELS.LINES_REMOVE, {}],
    [
      CART_IPC_CHANNELS.LINES_SET_NOTE,
      { cart_id: 'c', line_id: 'l', note: 123, version: 1, idempotency_key: 'k' },
    ],
    [CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD, {}],
    [CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_REMOVE, {}],
    [CART_IPC_CHANNELS.VOID, {}],
    [
      CART_IPC_CHANNELS.HANDOFF,
      { cart_id: 'c', per_line_versions: 'not-array', idempotency_key: 'k' },
    ],
    [
      CART_IPC_CHANNELS.HANDOFF,
      { cart_id: 'c', per_line_versions: [{ line_id: 'l' }], idempotency_key: 'k' },
    ],
    [CART_IPC_CHANNELS.SUBSCRIBE, {}],
  ])('refuses malformed payload on %s', async (channel, payload) => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`missing handler for ${channel}`);
    const result = (await handler(fakeEvent(), payload)) as { kind: string; reason?: string };
    expect(result.kind).toBe('refused');
  });
});

describe('registerCartHandlers — valid payload forwards to bridge', () => {
  it('CREATE forwards to bridge.create', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'create');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.CREATE);
    if (handler === undefined) throw new Error('missing CREATE');
    await handler(fakeEvent(), { idempotency_key: 'k' });
    expect(spy).toHaveBeenCalledWith({ idempotency_key: 'k' });
  });

  it('LINES_ADD forwards a fully-typed request to bridge.linesAdd', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'linesAdd');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.LINES_ADD);
    if (handler === undefined) throw new Error('missing LINES_ADD');
    const req = { cart_id: 'c', item_ref: 'SKU', quantity: 1, idempotency_key: 'k' };
    await handler(fakeEvent(), req);
    expect(spy).toHaveBeenCalledWith(req);
  });

  it('LINES_UPDATE forwards with delta+absolute optional fields', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'linesUpdate');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.LINES_UPDATE);
    if (handler === undefined) throw new Error('missing LINES_UPDATE');
    await handler(fakeEvent(), {
      cart_id: 'c',
      line_id: 'l',
      op: 'increment',
      delta: 2,
      version: 1,
      idempotency_key: 'k',
    });
    expect(spy).toHaveBeenCalled();
    const arg = spy.mock.calls[0]?.[0];
    expect(arg?.delta).toBe(2);
  });

  it('LINES_SET_NOTE accepts null note', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'linesSetNote');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.LINES_SET_NOTE);
    if (handler === undefined) throw new Error('missing LINES_SET_NOTE');
    await handler(fakeEvent(), {
      cart_id: 'c',
      line_id: 'l',
      note: null,
      version: 1,
      idempotency_key: 'k',
    });
    expect(spy).toHaveBeenCalled();
  });

  it('DISCOUNT_PLACEHOLDERS_ADD drops a renderer-supplied attribution_operator_id (RT-183)', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'discountPlaceholdersAdd');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD);
    if (handler === undefined) throw new Error('missing DISCOUNT_PLACEHOLDERS_ADD');
    await handler(fakeEvent(), {
      cart_id: 'c',
      line_id: 'l',
      placeholder_kind: 'X',
      attribution_operator_id: 'mgr-1',
      idempotency_key: 'k',
    });
    expect(spy).toHaveBeenCalled();
    const arg = spy.mock.calls[0]?.[0];
    expect(arg).not.toHaveProperty('attribution_operator_id');
  });

  it('VOID accepts optional attribution_operator_id', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'void');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.VOID);
    if (handler === undefined) throw new Error('missing VOID');
    await handler(fakeEvent(), {
      cart_id: 'c',
      attribution_operator_id: 'mgr-2',
      idempotency_key: 'k',
    });
    expect(spy).toHaveBeenCalled();
  });

  it('DISCOUNT_PLACEHOLDERS_REMOVE forwards with attribution optional', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'discountPlaceholdersRemove');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_REMOVE);
    if (handler === undefined) throw new Error('missing DISCOUNT_PLACEHOLDERS_REMOVE');
    await handler(fakeEvent(), {
      cart_id: 'c',
      placeholder_id: 'p',
      attribution_operator_id: 'mgr',
      idempotency_key: 'k',
    });
    expect(spy).toHaveBeenCalled();
  });

  it('HANDOFF forwards array of per_line_versions', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'handoff');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.HANDOFF);
    if (handler === undefined) throw new Error('missing HANDOFF');
    await handler(fakeEvent(), {
      cart_id: 'c',
      per_line_versions: [{ line_id: 'l1', version: 2 }],
      idempotency_key: 'k',
    });
    expect(spy).toHaveBeenCalled();
  });

  it('LINES_REMOVE forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'linesRemove');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.LINES_REMOVE);
    if (handler === undefined) throw new Error('missing LINES_REMOVE');
    await handler(fakeEvent(), {
      cart_id: 'c',
      line_id: 'l',
      version: 1,
      idempotency_key: 'k',
    });
    expect(spy).toHaveBeenCalled();
  });

  it('SUBSCRIBE forwards', async () => {
    const { ipcMain, handlers } = mkIpc();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'subscribe');
    registerCartHandlers(ipcMain, { handlers: bridge });
    const handler = handlers.get(CART_IPC_CHANNELS.SUBSCRIBE);
    if (handler === undefined) throw new Error('missing SUBSCRIBE');
    await handler(fakeEvent(), { cart_id: 'c' });
    expect(spy).toHaveBeenCalled();
  });
});
