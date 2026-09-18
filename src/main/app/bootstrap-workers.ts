/**
 * 021-pos-maintainability-rescue S1 — background-worker lifecycle.
 *
 * Owns the process-lifetime background workers' TEARDOWN: the stop callbacks,
 * their fixed ordering, failure isolation, and idempotency. Previously these
 * lived in `src/main/index.ts` as three module-scope `let` handles plus a
 * `runStopper` helper called from `closeDbHandle()`.
 *
 * **What this module does NOT own.** Worker *construction* stays at the
 * composition root, inside the branches that already gate it (the
 * `sale_finalization` feature flag for the finalize listener; the
 * paired-terminal branch for the read-down driver and the sale-sync interval).
 * Those branches carry the dependencies each worker needs, and moving them
 * would change startup wiring. Registration is therefore what encodes the
 * gate: a worker that is never started is never registered, and `stopAll()`
 * simply has nothing to stop for it.
 *
 * **Ordering is load-bearing.** Workers stop in a fixed order —
 * finalize → read-down → sale-sync — and the whole registry drains BEFORE the
 * DB handle closes, so a mid-flight background tick can never run against a
 * closed handle. `closeDbHandle()` at the composition root preserves that
 * sequencing by calling `stopAll()` first.
 *
 * **Idempotency is load-bearing.** On a normal Windows exit the shutdown path
 * is reached twice: `window-all-closed` closes the handle and then calls
 * `app.quit()`, whose `quit` listener closes it again. Each stop callback is
 * cleared as it runs (including when it throws), so a second `stopAll()` is a
 * no-op rather than a double `clearInterval` / double `stop()`.
 *
 * **Failures are isolated, never propagated.** A throwing stop routine is
 * logged and teardown continues — matching the previous `runStopper`
 * behaviour, where one wedged worker must not strand the rest or block quit.
 */

/**
 * The workers this registry manages, in the order they MUST be stopped.
 *
 * Order rationale (carried forward from the previous inline implementation):
 * the finalize listener is stopped first because it is the writer closest to
 * the sale-durability path, then the read-down driver, then the sale-sync
 * interval — after which the DB handle is safe to close.
 */
const STOP_ORDER = ['finalize listener', 'read-down driver', 'sale-sync interval'] as const;

export type WorkerName = (typeof STOP_ORDER)[number];

/** Minimal logger seam — satisfied by the pino main logger and by `console`. */
export interface WorkerRegistryLogger {
  error(...args: unknown[]): void;
}

export interface WorkerRegistryDeps {
  logger: WorkerRegistryLogger;
}

export interface WorkerRegistry {
  /**
   * Record a worker's stop callback. Called at the site where the worker is
   * started, so that not-started implies not-registered. Re-registering the
   * same name replaces the previous callback (the old one is never invoked).
   */
  register(name: WorkerName, stop: () => void): void;
  /**
   * Stop every registered worker in {@link STOP_ORDER}, clearing each as it
   * runs. Never throws: a failing stop routine is logged and teardown
   * continues. Safe to call repeatedly — subsequent calls are no-ops.
   */
  stopAll(): void;
  /** True while at least one worker is registered. Primarily for assertions. */
  hasRegistered(): boolean;
}

export function createWorkerRegistry(deps: WorkerRegistryDeps): WorkerRegistry {
  const stoppers = new Map<WorkerName, () => void>();

  return {
    register(name: WorkerName, stop: () => void): void {
      stoppers.set(name, stop);
    },

    stopAll(): void {
      for (const name of STOP_ORDER) {
        const stop = stoppers.get(name);
        if (stop === undefined) continue;
        // Clear BEFORE invoking so a throwing stopper is not retried on a
        // second stopAll() — this is what keeps the double-shutdown path
        // (window-all-closed → quit) idempotent.
        stoppers.delete(name);
        try {
          stop();
        } catch (err) {
          deps.logger.error(`[pos-pulse] failed to stop ${name}:`, err);
        }
      }
    },

    hasRegistered(): boolean {
      return stoppers.size > 0;
    },
  };
}
