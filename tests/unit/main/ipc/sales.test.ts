/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed mock properties on the bridge spy trigger this rule on every
 * assertion (`expect(bridge.read).toHaveBeenCalled`). Same posture as
 * `tests/unit/main/payments/bridge.payments-start.test.ts`.
 */
/**
 * T094c — `sales.*` IPC channel registration (RED).
 *
 * Mirrors `src/main/ipc/payments.ts` (006 F-004). A thin wire-up: each
 * SALES_IPC_CHANNELS entry is bound to the matching `sales.*` bridge
 * handler. No business logic — only "is this a plausible request object?"
 * then delegate. Semantic validation (session, tenant isolation, forbidden
 * fields, not-found) is the bridge handler's job and is tested there.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerSalesHandlers } from '../../../../src/main/ipc/sales.js';
import { SALES_IPC_CHANNELS } from '../../../../src/shared/sales/channels.js';
import type { SalesBridge } from '../../../../src/main/sales/sales-bridge.js';

// A fake IpcMain that records channel→handler registrations and lets the
// test invoke them.
function makeFakeIpcMain() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>
  >();
  const ipcMain = {
    handle(channel: string, handler: (e: IpcMainInvokeEvent, r: unknown) => Promise<unknown>) {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  const fakeEvent = {} as IpcMainInvokeEvent;
  return {
    ipcMain,
    invoke: (channel: string, request: unknown) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler for ${channel}`);
      return handler(fakeEvent, request);
    },
    channels: () => [...handlers.keys()],
  };
}

function makeBridgeSpy(): SalesBridge {
  return {
    read: vi.fn(() => Promise.resolve({ kind: 'ok', sale: { sale_id: 's1' } }) as never),
    findByNumber: vi.fn(() => Promise.resolve({ kind: 'ok', sale: { sale_id: 's1' } }) as never),
    subscribe: vi.fn(
      () => Promise.resolve({ kind: 'refused', reason: 'not_implemented' }) as never,
    ),
    unsubscribe: vi.fn(() => Promise.resolve({ kind: 'ok' }) as never),
    list: vi.fn(
      () =>
        Promise.resolve({
          kind: 'ok',
          sales: [],
          next_cursor: null,
          coverage: 'this_device_only',
        }) as never,
    ),
  };
}

describe('T094c — registerSalesHandlers', () => {
  it('registers all five sales.* channels', () => {
    const fake = makeFakeIpcMain();
    registerSalesHandlers(fake.ipcMain, { salesBridge: makeBridgeSpy() });
    const channels = fake.channels();
    expect(channels).toContain(SALES_IPC_CHANNELS.READ);
    expect(channels).toContain(SALES_IPC_CHANNELS.FIND_BY_NUMBER);
    expect(channels).toContain(SALES_IPC_CHANNELS.SUBSCRIBE);
    expect(channels).toContain(SALES_IPC_CHANNELS.UNSUBSCRIBE);
    expect(channels).toContain(SALES_IPC_CHANNELS.LIST);
    expect(SALES_IPC_CHANNELS.LIST).toBe('sales:list');
  });

  it('RT-541: delegates sales.list to the bridge with the request payload', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    const req = { from_day: '2026-10-16', to_day: '2026-10-16' };
    await fake.invoke(SALES_IPC_CHANNELS.LIST, req);
    expect(bridge.list).toHaveBeenCalledWith(req);
  });

  it.each([null, undefined, 42, 'x', ['2026-10-16']])(
    'RT-541: refuses a non-object sales.list request (%j) as invalid_request without calling the bridge',
    async (request) => {
      const fake = makeFakeIpcMain();
      const bridge = makeBridgeSpy();
      registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
      const res = await fake.invoke(SALES_IPC_CHANNELS.LIST, request);
      expect(res).toEqual({ kind: 'refused', reason: 'invalid_request' });
      expect(bridge.list).not.toHaveBeenCalled();
    },
  );

  it('delegates sales.read to the bridge with the request payload', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    const req = { sale_id: 'sale-123' };
    await fake.invoke(SALES_IPC_CHANNELS.READ, req);
    expect(bridge.read).toHaveBeenCalledWith(req);
  });

  it('delegates sales.findByNumber to the bridge', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    const req = { sale_number: 'TERM-01-2026-05-27-000001' };
    await fake.invoke(SALES_IPC_CHANNELS.FIND_BY_NUMBER, req);
    expect(bridge.findByNumber).toHaveBeenCalledWith(req);
  });

  it('delegates sales.subscribe and sales.unsubscribe to the bridge', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    await fake.invoke(SALES_IPC_CHANNELS.SUBSCRIBE, { topic: 'recent' });
    await fake.invoke(SALES_IPC_CHANNELS.UNSUBSCRIBE, { subscription_token: 'tok-1' });
    expect(bridge.subscribe).toHaveBeenCalledWith({ topic: 'recent' });
    expect(bridge.unsubscribe).toHaveBeenCalledWith({ subscription_token: 'tok-1' });
  });

  it('refuses a non-object sales.read request without calling the bridge', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    const res = (await fake.invoke(SALES_IPC_CHANNELS.READ, null)) as {
      kind: string;
      reason: string;
    };
    expect(res.kind).toBe('refused');
    expect(res.reason).toBe('sale_not_found');
    expect(bridge.read).not.toHaveBeenCalled();
  });

  it('refuses a non-object sales.findByNumber request without calling the bridge', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    const res = (await fake.invoke(SALES_IPC_CHANNELS.FIND_BY_NUMBER, 42)) as {
      kind: string;
      reason: string;
    };
    expect(res.kind).toBe('refused');
    expect(res.reason).toBe('sale_not_found');
    expect(bridge.findByNumber).not.toHaveBeenCalled();
  });

  it('refuses a non-object sales.subscribe request without calling the bridge', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    const res = (await fake.invoke(SALES_IPC_CHANNELS.SUBSCRIBE, undefined)) as {
      kind: string;
      reason: string;
    };
    expect(res.kind).toBe('refused');
    expect(res.reason).toBe('not_implemented');
    expect(bridge.subscribe).not.toHaveBeenCalled();
  });

  it('treats a malformed unsubscribe as a no-op ok (idempotent stub)', async () => {
    const fake = makeFakeIpcMain();
    const bridge = makeBridgeSpy();
    registerSalesHandlers(fake.ipcMain, { salesBridge: bridge });
    const res = (await fake.invoke(SALES_IPC_CHANNELS.UNSUBSCRIBE, null)) as { kind: string };
    expect(res.kind).toBe('ok');
    expect(bridge.unsubscribe).not.toHaveBeenCalled();
  });
});
