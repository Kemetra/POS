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
