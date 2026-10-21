import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, expect, test } from '@playwright/test';

/**
 * RT-773 — smallest possible real-Electron smoke: launch the built app on an
 * isolated profile, see the first window render the pairing screen, close
 * cleanly. Requires `npm run build` first (launches `dist/main/index.js`).
 *
 * Not an offline/SQLite/hardware/packaged-installer test.
 */
test('POS launches, renders the pairing screen on a fresh profile, closes cleanly', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  // Fresh temp profile: the real cashier DB, pairing state and secrets live
  // under the default userData and are never touched.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-pulse-e2e-'));

  // Hermetic launch env: drop Node-mode/dev-mode switches and every POS_PULSE_*
  // dev or feature flag from the caller's shell (e.g. POS_PULSE_DEV_SKIP_PAIRING
  // would seed pairing and route past the screen this test asserts). Windows
  // env names are case-insensitive, so compare upper-cased.
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      const name = entry[0].toUpperCase();
      return (
        entry[1] !== undefined &&
        !name.startsWith('POS_PULSE_') &&
        name !== 'ELECTRON_RUN_AS_NODE' &&
        name !== 'NODE_ENV'
      );
    }),
  );

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [repoRoot, `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env,
    });
    const proc = app.process();

    // The window is created asynchronously after `ready`; wait for it first.
    // `loadFile` is not awaited by the window factory, so the URL can still be
    // `about:blank` right after the window appears: assert it after the
    // pairing element is up.
    const page = await app.firstWindow();
    await expect(page.getByTestId('route-pairing')).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toContain('/renderer/index.html');

    // The app really is using the temp profile (SQLite lives under userData).
    const reportedUserData = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath('userData'),
    );
    expect(fs.realpathSync.native(reportedUserData)).toBe(fs.realpathSync.native(userDataDir));

    // Exactly one window exists: the cashier window, not a stray hidden one.
    const windowCount = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    expect(windowCount).toBe(1);

    await app.close();
    expect(proc.exitCode).toBe(0);
  } finally {
    // Runs on success and on any failure above: never leave an Electron
    // process or a temp profile behind.
    await app?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
