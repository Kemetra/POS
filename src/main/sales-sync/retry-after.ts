/**
 * RT-194 — parse an HTTP `Retry-After` header into a bounded delay.
 *
 * Backend-Core sends `Retry-After` on two capture answers that mean "the sale is
 * fine, ask again later":
 *   • 425 `idempotency_in_progress` — a request with the same Idempotency-Key is
 *     still in flight (`IdempotencyInterceptor`, `Retry-After: 2`);
 *   • 429 — the per-device write rate limit (`Retry-After` seconds, clamped by the
 *     server to [1, 300]).
 *
 * RFC 9110 §10.2.3 allows two forms: `delay-seconds` (a non-negative integer) or
 * an `HTTP-date`. Both are accepted; the date must be the preferred IMF-fixdate
 * (`Sun, 06 Nov 1994 08:49:37 GMT`), matched strictly BEFORE `Date.parse`, which
 * on its own also accepts non-HTTP strings (`October 5, 2026`, ISO-8601). The
 * obsolete rfc850 / asctime forms are treated as invalid (normal backoff — the
 * sale is still retried, only without the server's hint). The delay is clamped to
 * [0, `MAX_RETRY_AFTER_MS`] so a hostile or broken value can never park a sale for
 * longer than the engine's own backoff ceiling (5 min). A date in the past is 0.
 * A missing, empty or unparseable value returns `undefined`, and the caller falls
 * back to its normal backoff. Pure; never throws.
 */

/**
 * Upper bound on an honoured `Retry-After` (5 min). It equals the sale-sync
 * backoff ceiling (`index.ts`) and Backend-Core's own 429 clamp (300 s), so every
 * legitimate server value is honoured in full and no header can delay a retry
 * beyond what the engine already tolerates.
 */
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;

const DELAY_SECONDS = /^\d+$/;
/** RFC 9110 §5.6.7 IMF-fixdate, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`. Case-sensitive. */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function clamp(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/**
 * `Retry-After` → milliseconds to wait, clamped; `undefined` when absent or invalid.
 * `nowMs` is the local clock, used only for the HTTP-date form.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (DELAY_SECONDS.test(trimmed)) return clamp(Number(trimmed) * 1_000);
  if (!IMF_FIXDATE.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return clamp(at - nowMs);
}
