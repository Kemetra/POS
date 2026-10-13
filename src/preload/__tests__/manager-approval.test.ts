/** RT-443 (MA-2) — the `approval.*` preload members invoke their channels. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGER_APPROVAL_IPC_CHANNELS } from '../../shared/operator/manager-approval.js';

const ipcRendererInvoke = vi.fn(() => Promise.resolve({ kind: 'ok' }));
const exposeInMainWorld = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: { invoke: ipcRendererInvoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  contextBridge: { exposeInMainWorld },
}));

beforeEach(() => {
  ipcRendererInvoke.mockClear();
});

describe('preload approval bridge', () => {
  it('listApprovers and request invoke their channels with the request', async () => {
    const { approval } = await import('../manager-approval');
    await approval.listApprovers({ action_kind: 'cart.cancel_post_handoff' });
    expect(ipcRendererInvoke).toHaveBeenCalledWith(MANAGER_APPROVAL_IPC_CHANNELS.LIST_APPROVERS, {
      action_kind: 'cart.cancel_post_handoff',
    });
    const req = {
      action_kind: 'cart.cancel_post_handoff' as const,
      subject_ref: 'cart-1',
      reason_code: 'customer_left',
      approver_ref: '7f3c1e2a-0b4d-4c5e-8f60-0000000000aa',
      pin: '246810',
    };
    await approval.request(req);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(MANAGER_APPROVAL_IPC_CHANNELS.REQUEST, req);
  });

  it('is exposed on window.api.approval', async () => {
    vi.resetModules();
    await import('../index');
    const api = exposeInMainWorld.mock.calls.at(-1)?.[1] as {
      approval?: Record<string, unknown>;
    };
    expect(Object.keys(api.approval ?? {}).sort()).toEqual(['listApprovers', 'request']);
  });
});
