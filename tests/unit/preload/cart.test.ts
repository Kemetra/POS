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

async function importCart() {
  const mod = await import('../../../src/preload/cart.js');
  return mod.cart;
}

describe('preload cart — channel routing', () => {
  it('create() invokes ipcRenderer with CART_IPC_CHANNELS.CREATE and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = { idempotency_key: 'k1' };
    await cart.create(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.CREATE, req);
  });

  it('lines.add() invokes ipcRenderer with CART_IPC_CHANNELS.LINES_ADD and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = { cart_id: 'c1', item_ref: 'SKU-1', quantity: 1, idempotency_key: 'k2' };
    await cart.lines.add(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.LINES_ADD, req);
  });

  it('lines.update() invokes ipcRenderer with CART_IPC_CHANNELS.LINES_UPDATE and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = {
      cart_id: 'c1',
      line_id: 'l1',
      op: 'increment' as const,
      delta: 1,
      version: 1,
      idempotency_key: 'k3',
    };
    await cart.lines.update(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.LINES_UPDATE, req);
  });

  it('lines.remove() invokes ipcRenderer with CART_IPC_CHANNELS.LINES_REMOVE and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = { cart_id: 'c1', line_id: 'l1', version: 1, idempotency_key: 'k4' };
    await cart.lines.remove(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.LINES_REMOVE, req);
  });

  it('lines.setNote() invokes ipcRenderer with CART_IPC_CHANNELS.LINES_SET_NOTE and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = {
      cart_id: 'c1',
      line_id: 'l1',
      note: 'no subs',
      version: 1,
      idempotency_key: 'k5',
    };
    await cart.lines.setNote(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.LINES_SET_NOTE, req);
  });

  it('discountPlaceholders.add() invokes ipcRenderer with CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = {
      cart_id: 'c1',
      line_id: 'l1',
      placeholder_kind: 'STAFF_10PCT',
      idempotency_key: 'k6',
    };
    await cart.discountPlaceholders.add(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(
      CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD,
      req,
    );
  });

  it('RT-608: discountPlaceholders.add() forwards a cashier approval_id (and no credential field exists)', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_invalid' });
    const cart = await importCart();
    const req = {
      cart_id: 'c1',
      line_id: 'l1',
      placeholder_kind: 'percent_5',
      idempotency_key: 'k6b',
      approval_id: 'appr-1',
    };
    await cart.discountPlaceholders.add(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(
      CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD,
      req,
    );
  });

  it('discountPlaceholders.remove() invokes ipcRenderer with CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_REMOVE and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = { cart_id: 'c1', placeholder_id: 'p1', idempotency_key: 'k7' };
    await cart.discountPlaceholders.remove(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(
      CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_REMOVE,
      req,
    );
  });

  it('void() invokes ipcRenderer with CART_IPC_CHANNELS.VOID and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = { cart_id: 'c1', idempotency_key: 'k8' };
    await cart.void(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.VOID, req);
  });

  it('handoff() invokes ipcRenderer with CART_IPC_CHANNELS.HANDOFF and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = { cart_id: 'c1', per_line_versions: [], idempotency_key: 'k9' };
    await cart.handoff(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.HANDOFF, req);
  });

  it('subscribe() invokes ipcRenderer with CART_IPC_CHANNELS.SUBSCRIBE and the request', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ kind: 'refused', reason: 'not_implemented' });
    const cart = await importCart();
    const req = { cart_id: 'c1' };
    await cart.subscribe(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(CART_IPC_CHANNELS.SUBSCRIBE, req);
  });

  it('each handler passes through the ipcRenderer return value', async () => {
    const expected = { kind: 'refused' as const, reason: 'no_session' as const };
    ipcRendererInvoke.mockResolvedValueOnce(expected);
    const cart = await importCart();
    const result = await cart.create({ idempotency_key: 'k10' });
    expect(result).toEqual(expected);
  });
});
