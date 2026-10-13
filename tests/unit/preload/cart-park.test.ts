import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CART_PARK_IPC_CHANNELS } from '../../../src/shared/cart/channels.js';

/** RT-440 (PK-2) — `cart.parked.*` forwards each request unchanged on its constant channel. */

const ipcRendererInvoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: ipcRendererInvoke },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  ipcRendererInvoke.mockResolvedValue({ kind: 'refused', reason: 'no_session' });
});

describe('preload cart.parked (Park v1)', () => {
  it('invokes the four park channels with the request unchanged', async () => {
    const { cart } = await import('../../../src/preload/cart.js');
    const park = { cart_id: 'c1', label: 'bag', idempotency_key: 'k1' };
    const preview = { cart_id: 'c1' };
    const resume = {
      cart_id: 'c1',
      accept_changes: true,
      diff_token: 'ab',
      current_cart: 'keep' as const,
      idempotency_key: 'k2',
    };

    await cart.parked?.park(park);
    await cart.parked?.listParked();
    await cart.parked?.previewResume(preview);
    await cart.parked?.resume(resume);

    expect(ipcRendererInvoke.mock.calls).toEqual([
      [CART_PARK_IPC_CHANNELS.PARK, park],
      [CART_PARK_IPC_CHANNELS.LIST_PARKED],
      [CART_PARK_IPC_CHANNELS.PREVIEW_RESUME, preview],
      [CART_PARK_IPC_CHANNELS.RESUME, resume],
    ]);
  });
});
