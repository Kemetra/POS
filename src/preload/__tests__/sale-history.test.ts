/** RT-542 — the `saleHistory.*` preload members invoke their channels. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SALE_HISTORY_IPC_CHANNELS } from '../../shared/sale-history/types.js';

const ipcRendererInvoke = vi.fn(() => Promise.resolve({ kind: 'ok' }));
const exposeInMainWorld = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: { invoke: ipcRendererInvoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  contextBridge: { exposeInMainWorld },
}));

beforeEach(() => {
  ipcRendererInvoke.mockClear();
});

describe('preload saleHistory bridge', () => {
  it('each member invokes its channel with the request', async () => {
    const { saleHistory } = await import('../sale-history');
    await saleHistory.list({ from_day: '2026-10-16', to_day: '2026-10-16' });
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(SALE_HISTORY_IPC_CHANNELS.LIST, {
      from_day: '2026-10-16',
      to_day: '2026-10-16',
    });
    await saleHistory.read({ sale_ref: 'r-1' });
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(SALE_HISTORY_IPC_CHANNELS.READ, {
      sale_ref: 'r-1',
    });
    await saleHistory.reprint({ sale_ref: 'r-1', kind: 'sale_record' });
    expect(ipcRendererInvoke).toHaveBeenLastCalledWith(SALE_HISTORY_IPC_CHANNELS.REPRINT, {
      sale_ref: 'r-1',
      kind: 'sale_record',
    });
  });

  it('is exposed on window.api.saleHistory', async () => {
    vi.resetModules();
    await import('../index');
    const api = exposeInMainWorld.mock.calls.at(-1)?.[1] as {
      saleHistory?: Record<string, unknown>;
    };
    expect(Object.keys(api.saleHistory ?? {}).sort()).toEqual(['list', 'read', 'reprint']);
  });
});
