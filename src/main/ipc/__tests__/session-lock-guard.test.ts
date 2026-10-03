import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import {
  OPERATOR_IPC_CHANNELS,
  SESSION_LOCK_IPC_CHANNELS,
} from '../../../shared/operator/channels.js';
import { PAIRING_IPC_CHANNELS } from '../../../shared/pairing-types.js';

/**
 * RT-117 (RT-116 §2.5) — while the operator session is LOCKED, main serves an
 * ALLOWLIST only. Every other channel — including ones registered later — is
 * refused centrally, so a new handler is refused by default.
 */

type InvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type OnListener = (event: IpcMainEvent, ...args: unknown[]) => void;

function fakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  emit: (channel: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, InvokeListener>();
  const listeners = new Map<string, OnListener>();
  const ipcMain = {
    handle: (channel: string, listener: InvokeListener) => {
      handlers.set(channel, listener);
    },
    on: (channel: string, listener: OnListener) => {
      listeners.set(channel, listener);
      return ipcMain;
    },
  } as unknown as IpcMain;
  return {
    ipcMain,
    invoke: async (channel, ...args) => {
      const h = handlers.get(channel);
      if (h === undefined) throw new Error(`no handler for ${channel}`);
      return await h({} as IpcMainInvokeEvent, ...args);
    },
    emit: (channel, ...args) => {
      listeners.get(channel)?.({} as IpcMainEvent, ...args);
    },
  };
}

describe('RT-117 createSessionLockGuardedIpcMain', () => {
  it('passes every call through while the session is not locked', async () => {
    const fake = fakeIpcMain();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => false);
    guarded.handle('cart:lines-add', () => 'added');

    await expect(fake.invoke('cart:lines-add')).resolves.toBe('added');
  });

  it('refuses a non-allowlisted channel while locked and never runs its handler', async () => {
    const fake = fakeIpcMain();
    const handler = vi.fn(() => 'added');
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => true);
    guarded.handle('cart:lines-add', handler);

    await expect(fake.invoke('cart:lines-add')).rejects.toBeInstanceOf(SessionLockedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    'payments:start',
    'tender:apply',
    'cart:void',
    'receipts:reprint',
    'catalogue:search',
    'some-future:namespace',
    OPERATOR_IPC_CHANNELS.SIGN_IN,
    OPERATOR_IPC_CHANNELS.SIGN_OUT,
    OPERATOR_IPC_CHANNELS.TAKEOVER_CONFIRM,
    OPERATOR_IPC_CHANNELS.TAKEOVER_CANCEL,
    OPERATOR_IPC_CHANNELS.RESET_CASHIER_PIN,
    OPERATOR_IPC_CHANNELS.UNLOCK_CASHIER,
    OPERATOR_IPC_CHANNELS.FORCE_CLOSE_SHIFT,
    OPERATOR_IPC_CHANNELS.EMIT_AUDIT_EVENT,
  ])('refuses %s while locked', async (channel) => {
    const fake = fakeIpcMain();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => true);
    guarded.handle(channel, () => 'ran');

    await expect(fake.invoke(channel)).rejects.toBeInstanceOf(SessionLockedError);
  });

  it.each([
    SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE,
    SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION,
    OPERATOR_IPC_CHANNELS.GET_CURRENT_SESSION,
    OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY,
    PAIRING_IPC_CHANNELS.GET_STATUS,
    'app:ping',
    'app:version',
    'app:log',
    'app:config',
  ])('serves allowlisted %s while locked', async (channel) => {
    const fake = fakeIpcMain();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => true);
    guarded.handle(channel, () => 'ran');

    await expect(fake.invoke(channel)).resolves.toBe('ran');
  });

  it('the allowlist is exactly the RT-116 §2.5 S1 set', () => {
    expect([...LOCKED_ALLOWED_CHANNELS].sort()).toEqual(
      [
        SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE,
        SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION,
        OPERATOR_IPC_CHANNELS.GET_CURRENT_SESSION,
        OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY,
        PAIRING_IPC_CHANNELS.GET_STATUS,
        'app:ping',
        'app:version',
        'app:log',
        'app:config',
      ].sort(),
    );
  });

  it('re-evaluates the lock on every call (lock after registration is enforced)', async () => {
    const fake = fakeIpcMain();
    let locked = false;
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => locked);
    guarded.handle('cart:lines-add', () => 'added');

    await expect(fake.invoke('cart:lines-add')).resolves.toBe('added');
    locked = true;
    await expect(fake.invoke('cart:lines-add')).rejects.toBeInstanceOf(SessionLockedError);
    locked = false;
    await expect(fake.invoke('cart:lines-add')).resolves.toBe('added');
  });

  it('drops a non-allowlisted fire-and-forget (.on) event while locked', () => {
    const fake = fakeIpcMain();
    const listener = vi.fn();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => true);
    guarded.on('cart:something', listener);

    fake.emit('cart:something');

    expect(listener).not.toHaveBeenCalled();
  });

  it('delivers a fire-and-forget (.on) event while not locked', () => {
    const fake = fakeIpcMain();
    const listener = vi.fn();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => false);
    const returned = guarded.on('cart:something', listener);

    fake.emit('cart:something', 'arg');

    expect(listener).toHaveBeenCalledWith(expect.anything(), 'arg');
    expect(returned).toBe(fake.ipcMain);
  });

  it('delivers an allowlisted fire-and-forget (.on) event while locked', () => {
    const fake = fakeIpcMain();
    const listener = vi.fn();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => true);
    guarded.on(OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY, listener);

    fake.emit(OPERATOR_IPC_CHANNELS.REPORT_ACTIVITY);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('passes every other IpcMain member through to the real ipcMain', () => {
    const removeHandler = vi.fn();
    const real = { handle: vi.fn(), on: vi.fn(), removeHandler, label: 'real' };
    const guarded = createSessionLockGuardedIpcMain(real as unknown as IpcMain, () => true);

    guarded.removeHandler('cart:lines-add');

    // Methods are bound to the real ipcMain; plain values are returned as-is.
    expect(removeHandler).toHaveBeenCalledWith('cart:lines-add');
    expect(removeHandler.mock.contexts[0]).toBe(real);
    expect((guarded as unknown as { label: string }).label).toBe('real');
  });

  it('the refusal is generic (does not reflect the channel name)', async () => {
    const fake = fakeIpcMain();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain, () => true);
    guarded.handle('payments:start', () => 'ran');

    await expect(fake.invoke('payments:start')).rejects.toThrow('session_locked');
    await expect(fake.invoke('payments:start')).rejects.not.toThrow(/payments/);
  });
});
