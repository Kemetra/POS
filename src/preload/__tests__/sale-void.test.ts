/** RT-530 — the `saleVoid.*` preload members invoke their channels. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SALE_VOID_IPC_CHANNELS } from '../../shared/sale-void/types.js';

const ipcRendererInvoke = vi.fn(() => Promise.resolve({ kind: 'ok' }));
const exposeInMainWorld = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: { invoke: ipcRendererInvoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  contextBridge: { exposeInMainWorld },
}));

beforeEach(() => {
  ipcRendererInvoke.mockClear();
});

describe('preload saleVoid bridge', () => {
  it('each member invokes its channel with the request', async () => {
    const { saleVoid } = await import('../sale-void');
    await saleVoid.lookup({ sale_number: 'T1-2026-06-07-000001' });
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(SALE_VOID_IPC_CHANNELS.LOOKUP, {
      sale_number: 'T1-2026-06-07-000001',
    });
    await saleVoid.request({ sale_id: 's-1', approval_id: 'a-1' });
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(SALE_VOID_IPC_CHANNELS.REQUEST, {
      sale_id: 's-1',
      approval_id: 'a-1',
    });
    await saleVoid.list();
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(SALE_VOID_IPC_CHANNELS.LIST);
    await saleVoid.acknowledge({ void_id: 'v-1' });
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(SALE_VOID_IPC_CHANNELS.ACKNOWLEDGE, {
      void_id: 'v-1',
    });
  });

  it('is exposed on window.api.saleVoid', async () => {
    vi.resetModules();
    await import('../index');
    const api = exposeInMainWorld.mock.calls.at(-1)?.[1] as {
      saleVoid?: Record<string, unknown>;
    };
    expect(Object.keys(api.saleVoid ?? {}).sort()).toEqual([
      'acknowledge',
      'list',
      'lookup',
      'request',
    ]);
  });
});
