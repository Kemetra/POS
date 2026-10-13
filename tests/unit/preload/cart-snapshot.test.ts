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

describe('preload cart — snapshot (V5 active cart read)', () => {
  it('snapshot() invokes CART_IPC_CHANNELS.SNAPSHOT with the request unchanged', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'no_session' });
    const { cart } = await import('../../../src/preload/cart.js');
    const req = { cart_id: 'cart-1' };
    expect(typeof cart.snapshot).toBe('function');
    await cart.snapshot?.(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.SNAPSHOT, req);
  });

  it('adds exactly one read method to the cart bridge surface', async () => {
    const { cart } = await import('../../../src/preload/cart.js');
    // `cancelPostHandoff` is the audited post-handoff cancel (a mutation, not a
    // read), and RT-26's `returnToSale` is the guarded Checkout Back mutation;
    // the snapshot read remains the only read method on the surface. RT-440's
    // `parked` namespace is Park v1 (park / listParked / previewResume / resume).
    expect(Object.keys(cart).sort()).toEqual(
      [
        'cancelPostHandoff',
        'parked',
        'create',
        'discountPlaceholders',
        'handoff',
        'lines',
        'returnToSale',
        'returnToSaleEligibility',
        'snapshot',
        'subscribe',
        'undoLast',
        'void',
      ].sort(),
    );
    expect(Object.keys(cart.lines).sort()).toEqual(['add', 'remove', 'setNote', 'update']);
    expect(Object.keys(cart.parked ?? {}).sort()).toEqual([
      'listParked',
      'park',
      'previewResume',
      'resume',
    ]);
  });
});
