import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CART_IPC_CHANNELS } from '../../../src/shared/cart/channels.js';

const ipcRendererInvoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: ipcRendererInvoke },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('preload cart — returnToSale (RT-26)', () => {
  it('invokes only CART_IPC_CHANNELS.RETURN_TO_SALE with the request unchanged', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'ok' });
    const { cart } = await import('../../../src/preload/cart.js');
    const req = { cart_id: 'cart-1', handoff_action_id: 'handoff-1', idempotency_key: 'key-1' };
    expect(typeof cart.returnToSale).toBe('function');
    await expect(cart.returnToSale?.(req)).resolves.toEqual({ kind: 'ok' });
    expect(ipcRendererInvoke).toHaveBeenCalledOnce();
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.RETURN_TO_SALE, req);
  });
});

describe('preload cart — returnToSaleEligibility (RT-26)', () => {
  it('invokes only CART_IPC_CHANNELS.RETURN_TO_SALE_ELIGIBILITY with the request unchanged', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'ok', returnable: false });
    const { cart } = await import('../../../src/preload/cart.js');
    const req = { cart_id: 'cart-1', handoff_action_id: 'handoff-1' };
    await expect(cart.returnToSaleEligibility?.(req)).resolves.toEqual({
      kind: 'ok',
      returnable: false,
    });
    expect(ipcRendererInvoke).toHaveBeenCalledWith(
      CART_IPC_CHANNELS.RETURN_TO_SALE_ELIGIBILITY,
      req,
    );
  });
});
