import type { IpcMain } from 'electron';
import type { AppConfig } from '../../shared/app-config.js';

/**
 * Phase 9 / US7 — `app:config` IPC handler.
 *
 * The renderer asks main "what's my runtime config?" via this channel.
 * Currently the feature flags; future renderer-needed config lands on
 * the same channel. RT-634: the Sentry DSN no longer crosses it.
 *
 * The config getter is injected by `src/main/index.ts` so unit tests
 * never read the real environment. This is the same R2 pattern Phase 4
 * used for `dbPath` injection.
 */

export const APP_CONFIG_CHANNEL = 'app:config';

export function registerAppConfigHandler(ipcMain: IpcMain, getConfig: () => AppConfig): void {
  // Returns the config object directly; ipcMain.handle wraps it in a
  // Promise. The getter is called per-invocation (no caching) so a
  // future feature can rotate values at runtime without a restart.
  ipcMain.handle(APP_CONFIG_CHANNEL, () => getConfig());
}
