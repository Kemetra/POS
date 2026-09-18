import type { DatabaseHandle } from '../db/client.js';

/**
 * 021-pos-maintainability-rescue S2 — database handle lifetime.
 *
 * Owns the process-lifetime DB handle's OWNERSHIP and CLOSE mechanics.
 * Previously this was a module-scope `let dbHandle: DatabaseHandle | null` in
 * `src/main/index.ts` plus the close block inside `closeDbHandle()`.
 *
 * **What this module does NOT own.** Opening and migrating stay at the
 * composition root, inside `app.whenReady()`: the path comes from
 * `app.getPath('userData')`, the migrations directory from `app.isPackaged`,
 * and a migration failure must rethrow into the existing `.catch` that calls
 * `app.exit(1)`. Moving that would change startup semantics; this slice is
 * scoped to lifetime, not to the open sequence (plan AD-5).
 *
 * **Why a holder at all.** `dbHandle` was module-scope for exactly one reason:
 * `closeDbHandle()` lives outside `whenReady()` and needs a reference. All ~26
 * consumers are inside `whenReady()`, after the open — so the handle is a
 * teardown artifact, not genuinely shared process state. Giving ownership to a
 * holder lets the composition root use a plain local `const db` for all of
 * those consumers while the shutdown path still reaches the handle. That
 * discharges SC-1/FR-2 without the ~900-line threading refactor FR-6 forbids.
 *
 * **Idempotency is load-bearing.** The close path runs up to three times: the
 * startup `.catch` (possibly before the DB was ever opened), then
 * `window-all-closed`, then the `quit` listener. The handle must close exactly
 * once and never throw — a failing close that propagated would strand app
 * quit.
 */

/** Minimal logger seam — satisfied by the pino main logger and by `console`. */
export interface DatabaseHolderLogger {
  error(...args: unknown[]): void;
}

export interface DatabaseHolderDeps {
  logger: DatabaseHolderLogger;
}

export interface DatabaseHolder {
  /** Take ownership of an opened handle. */
  set(handle: DatabaseHandle): void;
  /**
   * Close the held handle, if any, and release it. Never throws: a failing
   * close is logged and swallowed. Safe to call repeatedly and safe to call
   * when nothing was ever opened — both are no-ops.
   */
  close(): void;
  /** True while a handle is held. */
  isOpen(): boolean;
}

export function createDatabaseHolder(deps: DatabaseHolderDeps): DatabaseHolder {
  let handle: DatabaseHandle | null = null;

  return {
    set(next: DatabaseHandle): void {
      handle = next;
    },

    close(): void {
      if (handle === null) return;
      // Release BEFORE closing so a throwing close is not retried on a second
      // shutdown pass — this is what keeps the double-close path idempotent.
      const closing = handle;
      handle = null;
      try {
        closing.close();
      } catch (err) {
        deps.logger.error('[pos-pulse] failed to close DB handle:', err);
      }
    },

    isOpen(): boolean {
      return handle !== null;
    },
  };
}
