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

  const env = { ...process.env } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['NODE_ENV'];

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [repoRoot, `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env,
    });
    const proc = app.process();

    // The window is created asynchronously after `ready`; wait for it first.
    const page = await app.firstWindow();
    expect(page.url()).toContain('/renderer/index.html');
    await expect(page.getByTestId('route-pairing')).toBeVisible({ timeout: 30_000 });

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
