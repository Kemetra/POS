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
 * The pairing service itself is not touched (`src/main/pairing/` belongs to 002):
 * {@link withPairedNotification} wraps it at the composition root instead.
 *
 * Re-pairing an already-paired terminal: the latch is set by the first
 * pairing, so workers keep the scope they started with. RT-215 (review F2)
 * relaunches the app after such a re-pair (see `hasStarted`).
 */

import type { PairingSubmitResult } from '../../shared/pairing-types.js';
import type { PairingService } from '../pairing/service.js';

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
  /**
   * RT-215 review F2 — true once the paired-only workers started in this
   * process (the first `notifyPaired`). They keep that scope; a re-pair after
   * this point needs a relaunch.
   */
  hasStarted(): boolean;
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

    hasStarted(): boolean {
      return paired !== null;
    },
  };
}

/**
 * Wrap a pairing service so a SUCCESSFUL pairing notifies `onPaired`.
 *
 * `PairingService.submit` resolves `success` only after the pairing has been
 * persisted, and resolves a typed non-success outcome for every failure (it
 * rejects only on programmer error). So notifying on `success` is exactly "the
 * pairing is durable" — never on a failure, never when `persist` threw.
 *
 * The notification is fire-and-forget and isolated: the caller always gets the
 * inner result (or the inner rejection) unchanged, whatever the hook does. The
 * hook owns reporting its own failure; a rejection is observed here only so it
 * cannot surface as an unhandled rejection.
 */
export function withPairedNotification(
  inner: PairingService,
  onPaired: () => void | Promise<void>,
): PairingService {
  return {
    async submit(pairing_code: string): Promise<PairingSubmitResult> {
      const result = await inner.submit(pairing_code);
      if (result.outcome === 'success') {
        try {
          void Promise.resolve(onPaired()).catch(() => undefined);
        } catch {
          // A synchronous throw from the hook must not alter the pairing result.
        }
      }
      return result;
    },
  };
}
