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
 * an `HTTP-date`. Both are accepted. The delay is clamped to
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
/** An HTTP-date always carries a day/month name; this rejects bare numbers like `-5`. */
const HAS_LETTER = /[a-z]/i;

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
  if (!HAS_LETTER.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return clamp(at - nowMs);
}
