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

describe('preload cart — undoLast (RT-254)', () => {
  it('invokes only CART_IPC_CHANNELS.UNDO_LAST with the request unchanged', async () => {
    const ok = { kind: 'ok', effect: 'restored', line_id: 'line-1', version: 4 };
    ipcRendererInvoke.mockResolvedValueOnce(ok);
    const { cart } = await import('../../../src/preload/cart.js');
    const req = { cart_id: 'cart-1', target_action_id: 'remove-1', idempotency_key: 'undo-1' };
    expect(typeof cart.undoLast).toBe('function');
    await expect(cart.undoLast?.(req)).resolves.toEqual(ok);
    expect(ipcRendererInvoke).toHaveBeenCalledOnce();
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.UNDO_LAST, req);
  });
});
