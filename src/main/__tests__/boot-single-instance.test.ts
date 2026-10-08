import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

/**
 * RT-203 — BEHAVIOURAL guard for the single-instance lock: the REAL
 * `src/main/index.ts` is imported against a fake Electron `app`.
 *
 * The static guard (`bootstrap-single-instance.test.ts`) pins source order;
 * this one proves the effect. A second launch (lock NOT acquired) must not
 * create a logger or open the database, however the app later becomes "ready"
 * (`whenReady()` resolving or a `ready` event firing). The positive control (lock
 * acquired) proves the harness can observe a boot at all, so the negative case
 * cannot pass vacuously.
 */

const h = vi.hoisted(() => {
  const readyListeners: (() => void)[] = [];
  const app = {
    gotLock: false,
    requestSingleInstanceLock: vi.fn(() => app.gotLock),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'ready') readyListeners.push(listener);
      return app;
    }),
    once: vi.fn((event: string, listener: () => void) => app.on(event, listener)),
    isPackaged: false,
    getAppPath: () => '/repo',
    getPath: () => '/tmp/pos-pulse-test',
    getVersion: () => '0.0.0-test',
    commandLine: { hasSwitch: () => false },
  };
  const openDatabase = vi.fn(() => {
    throw new Error('test: boot reached the DB open');
  });
  const createLogger = vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  );
  return { app, readyListeners, openDatabase, createLogger };
});

vi.mock('electron', () => ({
  app: h.app,
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  dialog: { showMessageBox: vi.fn(() => Promise.resolve()) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));
vi.mock('@sentry/electron/main', () => ({ init: vi.fn() }));
vi.mock('../db/client.js', () => ({ openDatabase: h.openDatabase }));
vi.mock('../logging/logger.js', () => ({
  createLogger: h.createLogger,
  waitForLogDrain: vi.fn(() => Promise.resolve()),
}));

/** Import main fresh, then make the app "ready" every way Electron can. */
async function bootMain(gotLock: boolean): Promise<void> {
  h.app.gotLock = gotLock;
  await import('../index.js');
  for (const listener of h.readyListeners) listener();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.readyListeners.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('main/index.ts boot under the single-instance lock (RT-203)', () => {
  it('a second launch quits and never creates a logger or opens the DB', async () => {
    await bootMain(false);

    expect(h.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.createLogger).not.toHaveBeenCalled();
    expect(h.openDatabase).not.toHaveBeenCalled();
  });

  it('control: the lock holder boots as far as the DB open', async () => {
    await bootMain(true);

    expect(h.app.quit).not.toHaveBeenCalled();
    expect(h.createLogger).toHaveBeenCalled();
    expect(h.openDatabase).toHaveBeenCalledTimes(1);
  });
});
