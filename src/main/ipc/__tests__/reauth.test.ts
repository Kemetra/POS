import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerReauthHandler } from '../reauth.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import { REAUTH_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type { ReauthenticateResponse } from '../../../shared/bridge-api.js';

/**
 * RT-358 — `operator:reauthenticate` IPC boundary (§A4): only `identifier` and
 * `password` (non-empty strings) reach the handler; anything else is refused
 * generically; a throw never crosses the bridge; the answer never carries a
 * credential; and the channel is refused while the session is locked.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): {
  ipcMain: Pick<IpcMain, 'handle'>;
  invoke: (c: string, ...a: unknown[]) => unknown;
} {
  const handlers = new Map<string, Listener>();
  return {
    ipcMain: {
      handle: (c: string, l: Listener) => {
        handlers.set(c, l);
      },
    },
    invoke: (c, ...a) => handlers.get(c)?.({} as IpcMainInvokeEvent, ...a),
  };
}

const INVALID = { kind: 'refused', category: 'invalid_input' };

describe('RT-358 registerReauthHandler', () => {
  it('passes only identifier and password to the handler', async () => {
    const fake = fakeIpcMain();
    const reauthenticate = vi.fn(
      (): Promise<ReauthenticateResponse> => Promise.resolve({ kind: 'reauthenticated' }),
    );
    registerReauthHandler(fake.ipcMain, { reauthHandler: { reauthenticate } });

    await expect(
      fake.invoke(REAUTH_IPC_CHANNELS.REAUTHENTICATE, {
        identifier: 'mgr@example.test',
        password: 'pw',
        operator_id: 'forged',
        jwt: 'forged',
      }),
    ).resolves.toEqual({ kind: 'reauthenticated' });
    expect(reauthenticate).toHaveBeenCalledWith({ identifier: 'mgr@example.test', password: 'pw' });
  });

  it.each([
    ['no payload', undefined],
    ['a string', 'x'],
    ['an empty identifier', { identifier: '', password: 'pw' }],
    ['a missing password', { identifier: 'x' }],
    ['a numeric password', { identifier: 'x', password: 1234 }],
  ])('%s → invalid_input, handler not called', async (_l, payload) => {
    const fake = fakeIpcMain();
    const reauthenticate = vi.fn();
    registerReauthHandler(fake.ipcMain, { reauthHandler: { reauthenticate } });

    await expect(fake.invoke(REAUTH_IPC_CHANNELS.REAUTHENTICATE, payload)).resolves.toEqual(
      INVALID,
    );
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it('a throwing handler → invalid_input, nothing thrown across the bridge', async () => {
    const fake = fakeIpcMain();
    registerReauthHandler(fake.ipcMain, {
      reauthHandler: { reauthenticate: () => Promise.reject(new Error('boom: secret')) },
    });
    await expect(
      fake.invoke(REAUTH_IPC_CHANNELS.REAUTHENTICATE, { identifier: 'x', password: 'pw' }),
    ).resolves.toEqual(INVALID);
  });
});

describe('RT-358 operator:reauthenticate behind the session lock guard', () => {
  it('is not on the locked-session allowlist', () => {
    expect(LOCKED_ALLOWED_CHANNELS.has(REAUTH_IPC_CHANNELS.REAUTHENTICATE)).toBe(false);
  });

  it('is refused while the session is locked and never runs the handler', async () => {
    const fake = fakeIpcMain();
    const reauthenticate = vi.fn();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain as IpcMain, () => true);
    registerReauthHandler(guarded, { reauthHandler: { reauthenticate } });

    await expect(
      fake.invoke(REAUTH_IPC_CHANNELS.REAUTHENTICATE, { identifier: 'x', password: 'pw' }),
    ).rejects.toBeInstanceOf(SessionLockedError);
    expect(reauthenticate).not.toHaveBeenCalled();
  });
});
