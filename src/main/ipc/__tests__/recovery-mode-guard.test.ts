import { describe, expect, it } from 'vitest';
import type { IpcMain } from 'electron';

import {
  RecoveryModeError,
  createRecoveryModeGuardedIpcMain,
  isRefusedInRecoveryMode,
} from '../recovery-mode-guard.js';

/** RT-441 (RT-116 §5.1) — a recovery-mode session may not sell. */

function fakeIpcMain() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipcMain = {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
    on: () => ipcMain,
  } as unknown as IpcMain;
  return {
    ipcMain,
    invoke: async (channel: string) => await handlers.get(channel)?.({}),
  };
}

describe('recovery-mode guard', () => {
  it.each(['cart:create', 'payments:start', 'tender:apply', 'vouchers:validate', 'returns:submit'])(
    'refuses %s in recovery mode',
    async (channel) => {
      const fake = fakeIpcMain();
      createRecoveryModeGuardedIpcMain(fake.ipcMain, () => true).handle(channel, () => 'ran');
      await expect(fake.invoke(channel)).rejects.toBeInstanceOf(RecoveryModeError);
    },
  );

  it.each([
    'recovery:list-held',
    'recovery:complete-attempt',
    'approval:request',
    'operator:sign-out',
    'app:ping',
  ])('serves %s in recovery mode', async (channel) => {
    const fake = fakeIpcMain();
    createRecoveryModeGuardedIpcMain(fake.ipcMain, () => true).handle(channel, () => 'ran');
    await expect(fake.invoke(channel)).resolves.toBe('ran');
    expect(isRefusedInRecoveryMode(channel)).toBe(false);
  });

  it('serves everything outside recovery mode, re-reading the mode on every call', async () => {
    let recovery = false;
    const fake = fakeIpcMain();
    createRecoveryModeGuardedIpcMain(fake.ipcMain, () => recovery).handle(
      'cart:create',
      () => 'ran',
    );
    await expect(fake.invoke('cart:create')).resolves.toBe('ran');
    recovery = true;
    await expect(fake.invoke('cart:create')).rejects.toBeInstanceOf(RecoveryModeError);
  });
});

describe('recovery-mode guard — on() and the rest of ipcMain', () => {
  function fakeIpcMainWithOn() {
    const listeners = new Map<string, (...a: unknown[]) => void>();
    const removed: string[] = [];
    const ipcMain = {
      handle: () => undefined,
      on: (channel: string, fn: (...a: unknown[]) => void) => {
        listeners.set(channel, fn);
        return ipcMain;
      },
      removeHandler: (channel: string) => {
        removed.push(channel);
      },
      marker: 'real-ipc-main',
    } as unknown as IpcMain;
    return {
      ipcMain,
      removed,
      emit: (channel: string, ...args: unknown[]) => listeners.get(channel)?.({}, ...args),
    };
  }

  it('drops a refused sale message in recovery mode and delivers it otherwise', () => {
    let recovery = true;
    const fake = fakeIpcMainWithOn();
    const seen: unknown[] = [];
    const guarded = createRecoveryModeGuardedIpcMain(fake.ipcMain, () => recovery);
    expect(guarded.on('cart:changed', (_event, payload) => seen.push(payload))).toBe(fake.ipcMain);
    fake.emit('cart:changed', 'refused');
    recovery = false;
    fake.emit('cart:changed', 'delivered');
    expect(seen).toEqual(['delivered']);
  });

  it('delivers a non-sale message in recovery mode', () => {
    const fake = fakeIpcMainWithOn();
    const seen: unknown[] = [];
    createRecoveryModeGuardedIpcMain(fake.ipcMain, () => true).on('app:ready', (_event, payload) =>
      seen.push(payload),
    );
    fake.emit('app:ready', 'ok');
    expect(seen).toEqual(['ok']);
  });

  it('forwards every other member to the real ipcMain, bound to it', () => {
    const fake = fakeIpcMainWithOn();
    const guarded = createRecoveryModeGuardedIpcMain(fake.ipcMain, () => true);
    // Detached on purpose: the proxy must hand back a method bound to the real ipcMain.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { removeHandler } = guarded;
    removeHandler('cart:create');
    expect(fake.removed).toEqual(['cart:create']);
    expect((guarded as unknown as { marker: string }).marker).toBe('real-ipc-main');
  });

  it('refuses generically, without naming the channel', () => {
    const error = new RecoveryModeError();
    expect(error.message).toBe('recovery_mode');
    expect(error.name).toBe('RecoveryModeError');
  });
});
