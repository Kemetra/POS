import type { PrintDispatcher } from '../receipts/print-dispatcher.js';

/**
 * RT-772 slice 2 — "a print is in progress" has no durable state (a print is a
 * short in-memory dispatch), so main counts the in-flight dispatches. The
 * SafePointGate reads `isActive()`; a restart clears it, which is correct (an
 * interrupted print is already recorded as a failure by the dispatcher).
 */

export interface PrintActivity {
  /** Run `op`, counting it as in-flight until it settles. Errors pass through. */
  track<T>(op: () => Promise<T>): Promise<T>;
  isActive(): boolean;
}

export function createPrintActivity(): PrintActivity {
  let inFlight = 0;
  return {
    track<T>(op: () => Promise<T>): Promise<T> {
      inFlight += 1;
      const settle = (): void => {
        inFlight -= 1;
      };
      let pending: Promise<T>;
      try {
        pending = op();
      } catch (error) {
        settle();
        throw error;
      }
      return pending.finally(settle);
    },
    isActive: () => inFlight > 0,
  };
}

/** The same dispatcher, with every dispatch counted by `activity`. */
export function trackPrintDispatcher(
  dispatcher: PrintDispatcher,
  activity: PrintActivity,
): PrintDispatcher {
  return {
    dispatchFirstPrint: (...args) => activity.track(() => dispatcher.dispatchFirstPrint(...args)),
    dispatchRetryPrint: (...args) => activity.track(() => dispatcher.dispatchRetryPrint(...args)),
    dispatchReprint: (...args) => activity.track(() => dispatcher.dispatchReprint(...args)),
  };
}
