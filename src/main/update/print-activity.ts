import type { PrintPipeline } from '../receipts/print-pipeline.js';

/**
 * RT-772 slice 2 — "a print is in progress" has no durable state (a print is a
 * short in-memory dispatch), so main counts the in-flight dispatches. The
 * SafePointGate reads `isActive()`; a restart clears it, which is correct (an
 * interrupted print is already recorded as a failure by the dispatcher).
 *
 * Counting happens at the print pipeline, the one place every print ends up (receipts, the cash
 * return slip, sale-history reprints), so no consumer can bypass it.
 */

export interface PrintActivity {
  /**
   * Run `op`, counting it as in-flight from the call until it settles. Errors pass
   * through; a synchronous throw from `op` becomes a rejection.
   */
  track<T>(op: () => Promise<T>): Promise<T>;
  isActive(): boolean;
}

export function createPrintActivity(): PrintActivity {
  let inFlight = 0;
  return {
    // `async`: the count rises before the first `await`, so it is already visible when
    // `track` returns, and the `finally` settles it on success, rejection or a sync throw.
    async track<T>(op: () => Promise<T>): Promise<T> {
      inFlight += 1;
      try {
        return await op();
      } finally {
        inFlight -= 1;
      }
    },
    isActive: () => inFlight > 0,
  };
}

/** The same pipeline, with every print counted by `activity`. */
export function trackPrintPipeline(
  pipeline: PrintPipeline,
  activity: PrintActivity,
): PrintPipeline {
  return {
    render: (payload) => activity.track(() => pipeline.render(payload)),
    printRendered: (rendered) => activity.track(() => pipeline.printRendered(rendered)),
  };
}
