/**
 * RT-17 (comments 10941 item 4 / 10948) — the sale-sync interval and its worker
 * stop, kept out of `index.ts` so they are unit-tested.
 *
 * The stop (registered in `bootstrap-workers.ts` as `sale-sync interval`, run
 * synchronously right before the DB handle closes) clears the interval and
 * latches the engine stopped (RT-198, as the shift sync worker and the returns
 * resolver), so a send in flight settles without any local write: no
 * `markSynced` / `recordTransient` / `markDeadLetter` on the closing DB. The sale
 * stays pending and is re-sent, same bytes and key, on the next start. The stop
 * also returns the engine's drain: settled once the tick in flight has settled,
 * bounded by `drainTimeoutMs`. The worker registry does not await it (its stops
 * are synchronous); the latch is what makes closing the DB right after safe.
 */
import type { SaleSyncEngine } from './sale-sync-engine.js';

export interface ScheduleSaleSyncInput {
  readonly engine: Pick<SaleSyncEngine, 'runTickOnce' | 'drain'>;
  /**
   * Latches the engine stopped: sets what the engine's `isStopped` reads.
   * Synchronous and idempotent.
   */
  readonly latchStopped: () => void;
  readonly intervalMs: number;
  /** Upper bound on waiting for a send in flight (the client's request timeout). */
  readonly drainTimeoutMs: number;
  readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Drain the sale-sync outbox on an interval (the first tick after one interval).
 * The single-flight engine coalesces overlapping ticks. Returns the worker
 * stopper (see the module header).
 */
export function scheduleSaleSync(input: ScheduleSaleSyncInput): () => Promise<void> {
  const timer = setInterval(() => {
    const admission = input.engine.runTickOnce();
    if (admission.kind === 'started') {
      admission.completed.catch((err: unknown) => {
        input.logger.error({ err }, 'sale_sync:tick_unexpected');
      });
    }
  }, input.intervalMs);
  return () => {
    clearInterval(timer);
    input.latchStopped();
    return input.engine.drain(input.drainTimeoutMs);
  };
}
