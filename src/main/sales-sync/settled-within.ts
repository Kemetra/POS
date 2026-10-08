/**
 * RT-17 follow-up (comments 10941 / 10949) — the one bounded wait behind every
 * worker drain (sale-sync engine, shift sync engine, returns resolver): a stop
 * waits for the send in flight, but never longer than a bound.
 */

/**
 * How much longer than its client's request timeout a drain waits: the send in
 * flight is aborted by the client at its timeout, so the drain, bounded just
 * above it, sees that send settle instead of giving up on the same instant.
 * Each worker's drain bound is its client timeout plus this margin
 * (`SALE_SYNC_DRAIN_TIMEOUT_MS`, `SHIFT_SYNC_DRAIN_TIMEOUT_MS`).
 */
export const DRAIN_MARGIN_MS = 1_000;

/**
 * `work` settled (either way) or `timeoutMs` passed, whichever is first.
 * Never rejects, never cancels `work`, and leaves no timer behind.
 */
export function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([settled, bound]).finally(() => {
    clearTimeout(timer);
  });
}
