import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerSessionLockHandlers } from '../session-lock.js';
import { SESSION_LOCK_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type { LockStateView, UnlockSessionResponse } from '../../../shared/bridge-api.js';

/**
 * RT-117 — `operator:unlock-session` and `operator:get-lock-state` IPC.
 * Boundary validation refuses generically and never echoes the payload.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (c: string, ...a: unknown[]) => Promise<unknown>;
} {
  const handlers = new Map<string, Listener>();
  return {
    ipcMain: {
      handle: (c: string, l: Listener) => {
        handlers.set(c, l);
      },
    } as unknown as IpcMain,
    invoke: async (c, ...a) => await handlers.get(c)?.({} as IpcMainInvokeEvent, ...a),
  };
}

const VIEW: LockStateView = {
  state: 'locked',
  locked_at: '2026-10-01T10:10:00.000Z',
  role: 'cashier',
  display_name: 'Cashier',
  summary: { line_count: 1, total_minor: 2550, tender_applied_minor: 1000, has_live_tender: true },
};

describe('RT-117 registerSessionLockHandlers', () => {
  it('forwards a well-formed PIN unlock request to the unlock handler', async () => {
    const fake = fakeIpcMain();
    const unlock = vi.fn(() => Promise.resolve<UnlockSessionResponse>({ kind: 'unlocked' }));
    registerSessionLockHandlers(fake.ipcMain, {
      unlockHandler: { unlock },
      getLockState: () => VIEW,
    });

    const res = await fake.invoke(SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION, {
      method: 'pin',
      pin: '1234',
    });

    expect(res).toEqual({ kind: 'unlocked' });
    expect(unlock).toHaveBeenCalledWith({ method: 'pin', pin: '1234' });
  });

  it('forwards only the known fields of an online-credential request', async () => {
    const fake = fakeIpcMain();
    const unlock = vi.fn(() => Promise.resolve<UnlockSessionResponse>({ kind: 'unlocked' }));
    registerSessionLockHandlers(fake.ipcMain, {
      unlockHandler: { unlock },
      getLockState: () => VIEW,
    });

    await fake.invoke(SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION, {
      method: 'online_credential',
      identifier: 'mgr@example.test',
      password: 'pw',
      operator_id: 'spoofed',
    });

    expect(unlock).toHaveBeenCalledWith({
      method: 'online_credential',
      identifier: 'mgr@example.test',
      password: 'pw',
    });
  });

  it.each([null, 'pin', 42, {}, { method: 'pin' }, { method: 'pin', pin: 1234 }, { method: 'x' }])(
    'refuses a malformed request %j generically without calling the handler',
    async (payload) => {
      const fake = fakeIpcMain();
      const unlock = vi.fn();
      registerSessionLockHandlers(fake.ipcMain, {
        unlockHandler: { unlock },
        getLockState: () => VIEW,
      });

      const res = await fake.invoke(SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION, payload);

      expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
      expect(unlock).not.toHaveBeenCalled();
    },
  );

  it('maps an unexpected throw to a generic refusal (no message leaks)', async () => {
    const fake = fakeIpcMain();
    const unlock = vi.fn(() => Promise.reject(new Error('secret pin 1234 in message')));
    registerSessionLockHandlers(fake.ipcMain, {
      unlockHandler: { unlock },
      getLockState: () => VIEW,
    });

    const res = await fake.invoke(SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION, {
      method: 'pin',
      pin: '1234',
    });

    expect(res).toEqual({ kind: 'refused', category: 'invalid_input' });
  });

  it('returns the lock-state view', async () => {
    const fake = fakeIpcMain();
    registerSessionLockHandlers(fake.ipcMain, {
      unlockHandler: { unlock: vi.fn() },
      getLockState: () => VIEW,
    });

    await expect(fake.invoke(SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE)).resolves.toEqual(VIEW);
  });
});
