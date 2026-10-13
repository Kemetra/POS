/** RT-441 (RT-116 §7.2) — the `recovery.*` preload members invoke their channels. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RECOVERY_IPC_CHANNELS } from '../../shared/operator/recovery.js';

const ipcRendererInvoke = vi.fn(() => Promise.resolve({ kind: 'ok' }));
const exposeInMainWorld = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: { invoke: ipcRendererInvoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  contextBridge: { exposeInMainWorld },
}));

beforeEach(() => {
  ipcRendererInvoke.mockClear();
});

describe('preload recovery bridge', () => {
  it('listHeld invokes its channel with no payload', async () => {
    const { recovery } = await import('../recovery');
    await recovery.listHeld();
    expect(ipcRendererInvoke).toHaveBeenCalledWith(RECOVERY_IPC_CHANNELS.LIST_HELD);
  });

  it('each action invokes its channel with the request', async () => {
    const { recovery } = await import('../recovery');
    const complete = { payment_attempt_id: 'a-1', approval_id: 'ap-1', cash_received_minor: 100 };
    await recovery.completeAttempt(complete);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(
      RECOVERY_IPC_CHANNELS.COMPLETE_ATTEMPT,
      complete,
    );
    const cancel = {
      payment_attempt_id: 'a-1',
      approval_id: 'ap-2',
      cash_returned_confirmed: true,
    };
    await recovery.cancelAttempt(cancel);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(RECOVERY_IPC_CHANNELS.CANCEL_ATTEMPT, cancel);
    const held = { cart_id: 'c-1', approval_id: 'ap-3' };
    await recovery.cancelHeldCart(held);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(RECOVERY_IPC_CHANNELS.CANCEL_HELD_CART, held);
  });

  it('is exposed on window.api.recovery', async () => {
    vi.resetModules();
    await import('../index');
    const api = exposeInMainWorld.mock.calls.at(-1)?.[1] as {
      recovery?: Record<string, unknown>;
    };
    expect(Object.keys(api.recovery ?? {}).sort()).toEqual([
      'cancelAttempt',
      'cancelHeldCart',
      'completeAttempt',
      'listHeld',
    ]);
  });
});
