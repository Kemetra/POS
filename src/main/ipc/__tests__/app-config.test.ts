import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { APP_CONFIG_CHANNEL, registerAppConfigHandler } from '../app-config.js';
import type { AppConfig } from '../../../shared/app-config.js';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * Phase 9 / US7 — `app:config` IPC handler tests.
 *
 * The handler is the one-way path the renderer uses to learn its
 * runtime config (feature flags). It MUST NOT pull
 * config from `process.env` directly — the closure is injected by
 * `src/main/index.ts` so unit tests stay free of the real environment.
 */

describe('registerAppConfigHandler', () => {
  it('registers exactly one handler on the app:config channel', () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;

    registerAppConfigHandler(ipcMain, () => ({}));

    expect(APP_CONFIG_CHANNEL).toBe('app:config');
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(APP_CONFIG_CHANNEL, expect.any(Function));
  });

  it('returns the config produced by the injected getter', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const config: AppConfig = { features: { cart: true } };

    registerAppConfigHandler(ipcMain, () => config);

    const captured = handle.mock.calls[0]?.[1];
    if (!captured) throw new Error('handler not registered');
    const result = await captured({} as IpcMainInvokeEvent);
    expect(result).toEqual(config);
  });

  it('returns an empty config when nothing is configured', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;

    registerAppConfigHandler(ipcMain, () => ({}));

    const captured = handle.mock.calls[0]?.[1];
    if (!captured) throw new Error('handler not registered');
    const result = await captured({} as IpcMainInvokeEvent);
    expect(result).toEqual({});
  });

  it('calls the getter on every invocation (not cached)', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const getter = vi.fn<() => AppConfig>(() => ({}));

    registerAppConfigHandler(ipcMain, getter);

    const captured = handle.mock.calls[0]?.[1];
    if (!captured) throw new Error('handler not registered');
    await captured({} as IpcMainInvokeEvent);
    await captured({} as IpcMainInvokeEvent);
    expect(getter).toHaveBeenCalledTimes(2);
  });
});
