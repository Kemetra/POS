/**
 * 006 Wave 3 — shared helper for extracting `error.code` from a 4xx
 * response body parsed as `unknown`.
 *
 * The voucher V-A clients (`validate.ts` / `redeem.ts` / `reverse.ts`)
 * parse Data-Pulse-2 responses defensively (`as unknown`) and pull
 * ONLY the `error.code` string out — never the full body. That guards
 * F-A4B-001 (closed-set enforcement) and FR-017 (the raw body might
 * carry an intent_token in some forward-compatible field).
 */

/**
 * Returns `error.code` if `raw` shape-matches
 * `components.schemas.Error`; otherwise returns `undefined`.
 */
export function extractErrorCode(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const err = (raw as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
