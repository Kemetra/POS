/**
 * RT-202 — paired-only worker lifecycle.
 *
 * The catalogue read-down driver, the AD-2 finalize listener and the 011
 * sale-sync engine all need the paired terminal's scope (tenant / branch /
 * terminal). They were built only in a "paired at boot" branch of the
 * composition root. Pairing, however, happens in the renderer without a process
 * relaunch, so a terminal that booted unpaired and paired afterwards stayed
 * without those workers until the app was restarted.
 *
 * This module is the single once-latch behind both entry points. The composition
 * root registers a *starter* for each paired-only worker group at the same site
 * where the worker was previously built, then tells the latch when the terminal
 * is paired:
 *
 *   • booted already paired → `notifyPaired` first, so every later `register`
 *     starts immediately — the same order, the same synchronous behaviour and the
 *     same error propagation as the old inline branches;
 *   • booted unpaired       → starters are held until `notifyPaired`, which the
 *     pairing service triggers after the pairing is persisted;
 *   • shutting down         → `close()` refuses late starts, so a pairing that
 *     completes while the app is quitting can never build a worker against a
 *     DB handle that is about to close (or already closed).
 *
 * Each starter runs at most once per process. A starter that throws on the
 * deferred path is logged and never retried: a retry could build a second copy of
 * a half-started worker (duplicate intervals / listeners).
 *
 * Out of scope: re-pairing an already-paired terminal. The latch is set by the
 * first pairing, so workers keep the scope they started with — as they did when
 * they were bound at boot.
 */

/** The scope a paired-only worker is built with (re-read from the pairing store). */
export interface PairedTerminal {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

export type PairedWorkerStarter = (terminal: PairedTerminal) => void;

/** Minimal logger seam — satisfied by the pino main logger. */
export interface PairedWorkersLogger {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface PairedWorkersDeps {
  logger: PairedWorkersLogger;
}

export interface PairedWorkers {
  /**
   * Register a paired-only starter. Already paired → it starts now and a failure
   * propagates to the caller (boot behaviour is unchanged). Not paired yet → it is
   * held until {@link notifyPaired}. Ignored after {@link close}.
   */
  register(name: string, start: PairedWorkerStarter): void;
  /**
   * The terminal is paired. The first call starts every held starter in
   * registration order (a failure is logged and isolated, the rest still start);
   * every later call is a no-op. Ignored after {@link close}.
   */
  notifyPaired(terminal: PairedTerminal): void;
  /** Refuse any further start. Idempotent. */
  close(): void;
}

interface Pending {
  name: string;
  start: PairedWorkerStarter;
}

export function createPairedWorkers(deps: PairedWorkersDeps): PairedWorkers {
  const { logger } = deps;
  let paired: PairedTerminal | null = null;
  let closed = false;
  let pending: Pending[] = [];

  return {
    register(name: string, start: PairedWorkerStarter): void {
      if (closed) return;
      if (paired !== null) {
        start(paired);
        return;
      }
      pending.push({ name, start });
    },

    notifyPaired(terminal: PairedTerminal): void {
      if (closed || paired !== null) return;
      paired = terminal;
      const toStart = pending;
      pending = [];
      for (const { name, start } of toStart) {
        try {
          start(terminal);
        } catch (err) {
          logger.error(
            { worker: name, error: err instanceof Error ? err.message : String(err) },
            'paired_workers:start_failed',
          );
        }
      }
    },

    close(): void {
      closed = true;
      pending = [];
    },
  };
}
