/**
 * RT-203 — one POS process per terminal.
 *
 * Electron's `app.requestSingleInstanceLock()` admits ONE main process per
 * user-data directory, which is also where the terminal's SQLite database
 * lives. Several main-process structures are process-local and are only
 * correct because of that:
 *
 *   - sale sync, the catalogue read-down, the finalize listener, the payments
 *     deferred-reversal resolver and the returns resolver are single-flight
 *     through in-memory flags;
 *   - the returns dispatcher's in-flight map (and the returns payout
 *     serialization) coordinates the sends and drawer kick for one return;
 *   - the drawer-kick double-kick guard is a read-then-write (the
 *     `UNIQUE(sale_id)` constraint is only the backstop);
 *   - receipt printing and the drawer assume one owner of the device.
 *
 * A second process on the same database would race every one of them, so a
 * second launch must quit before it touches anything. Removing or bypassing
 * this lock re-opens that whole race class.
 */

/** The slice of Electron's `app` this module needs (a fake in tests). */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  whenReady(): Promise<void>;
  on(event: 'second-instance', listener: () => void): unknown;
}

/** The slice of a `BrowserWindow` needed to bring the running till back. */
export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/**
 * Take the terminal's single-instance lock.
 *
 * - Lock acquired: listens for later launches (`onSecondInstance`) and returns
 *   the app's ready promise, so the caller chains its whole boot on it.
 * - Lock NOT acquired: quits and returns `null`. It never waits for `ready`, so
 *   nothing can be chained: no logger, DB, migrations, workers, IPC or window.
 *
 * Call it before anything else in main.
 */
export function acquireSingleInstance(
  app: SingleInstanceApp,
  onSecondInstance: () => void,
): Promise<void> | null {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  app.on('second-instance', onSecondInstance);
  return app.whenReady();
}

/**
 * Bring the running cashier window to the front after a second launch:
 * restore it if minimized (restoring an un-minimized window would undo a
 * maximize), then focus it. No window yet (the second launch arrived while
 * the first is still booting) or a destroyed one: nothing to do.
 */
export function restoreAndFocus(win: FocusableWindow | undefined): void {
  if (win === undefined || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}
