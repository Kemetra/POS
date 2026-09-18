/**
 * 006 T250 — `vouchers.validate` HTTP client (GREEN).
 *
 * Calls `POST /api/pos/v1/vouchers/validate` against Data-Pulse-2 and
 * maps the response into a typed result envelope. Follows the
 * resolve-on-reachable / reject-only-on-transport contract established
 * by 002's `network.pair()` and 004's `createBackendClient` —
 * EVERY outcome resolves; the function never throws.
 *
 * Result envelope:
 *
 *   - `{ kind: 'validated', applied_amount_minor, intent_expires_at,
 *      redemption_intent_token }` — 200 success, body unwrapped.
 *   - `{ kind: 'refused', reason: VoucherRefusalReason }` — 4xx with
 *     a known `error.code` (or `'validation_failure'` for unknown
 *     codes per F-A4B-001).
 *   - `{ kind: 'authority_unreachable' }` — transport failure / 5xx /
 *     401 / 425 Too Early / malformed body. The Wave-4 FSM consumer
 *     uses this sentinel to drive `applied → reversal_pending`
 *     (research §R-13). The client itself MUST NOT call into the FSM
 *     module — that is Wave 4 scope.
 *
 * **Redaction (FR-017 / F-A4B-004):**
 *   - The cashier-keyed voucher `code` is NEVER logged.
 *   - The response `redemption_intent_token` is NEVER logged.
 *   - The raw 4xx response body is NEVER stringified into a log
 *     argument (only the validated `error.code` is propagated).
 */
import type { components } from '../../../shared/api-types.js';

import { extractErrorCode } from './error-body.js';
import {
  mapRefusalCode,
  type VoucherAuthorityLogger,
  type VoucherRefusalReason,
} from './refusal-mapping.js';

function isValidatedResponse(raw: unknown): raw is ValidateVoucherOk {
  return (
    typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'validated'
  );
}

/**
 * Operation-derived request shape — F-A4B-002 compliant
 * (no import from the admin `Voucher*` schemas).
 */
export type ValidateVoucherInput = components['schemas']['PosValidateVoucherRequest'];

/** Operation-derived success-response shape (kind = 'validated'). */
export type ValidateVoucherOk = components['schemas']['PosValidateVoucherResponse'];

/** Discriminated union returned by `validateVoucher`. */
export type ValidateVoucherOutcome =
  | ValidateVoucherOk
  | { kind: 'refused'; reason: VoucherRefusalReason }
  | { kind: 'authority_unreachable' };

export interface ValidateVoucherDeps {
  /** Data-Pulse-2 base URL, e.g. `https://api.example.test`. */
  baseUrl: string;
  /** `fetch` implementation. Production binds the global; tests inject. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Pino-style structured logger. */
  logger: VoucherAuthorityLogger;
  /** Caller-generated UUID v4. */
  idempotencyKey: string;
  /** Override the request timeout (ms). Defaults to 15s, matching 004. */
  timeoutMs?: number;
}

const VALIDATE_PATH = '/api/pos/v1/vouchers/validate';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function validateVoucher(
  input: ValidateVoucherInput,
  deps: ValidateVoucherDeps,
): Promise<ValidateVoucherOutcome> {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await deps.fetch(`${root}${VALIDATE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': deps.idempotencyKey,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Transport failure (DNS / TLS / refused / timeout / abort) →
    // Wave-4 FSM uses the sentinel to drive reversal_pending.
    deps.logger.warn(
      { endpoint: 'validate', outcome: 'authority_unreachable' },
      'voucher_authority:transport_failure',
    );
    return { kind: 'authority_unreachable' };
  }

  // 2xx — try to unwrap the success envelope.
  if (response.ok) {
    try {
      const raw = (await response.json()) as unknown;
      // Defensive: confirm the discriminator is present before trusting it.
      if (isValidatedResponse(raw)) return raw;
      deps.logger.warn(
        { endpoint: 'validate', reason: 'malformed_success_body' },
        'voucher_authority:malformed_response',
      );
      return { kind: 'authority_unreachable' };
    } catch {
      deps.logger.warn(
        { endpoint: 'validate', reason: 'json_parse_failure' },
        'voucher_authority:malformed_response',
      );
      return { kind: 'authority_unreachable' };
    }
  }

  // 4xx — try to map a closed-set refusal code.
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 401 &&
    response.status !== 425
  ) {
    let code: string | undefined;
    try {
      const raw = (await response.json()) as unknown;
      // Extract ONLY the `error.code` — never log the whole body.
      code = extractErrorCode(raw);
    } catch {
      // fall through to validation_failure
    }
    if (!code) {
      deps.logger.warn(
        { endpoint: 'validate', reason: 'missing_error_code', status: response.status },
        'voucher_authority:refused_no_code',
      );
      return { kind: 'refused', reason: 'validation_failure' };
    }
    const reason = mapRefusalCode(code, 'validate', deps.logger);
    return { kind: 'refused', reason };
  }

  // 401 / 425 / 5xx / anything else → unreachable.
  deps.logger.warn(
    { endpoint: 'validate', status: response.status, outcome: 'authority_unreachable' },
    'voucher_authority:non_ok_response',
  );
  return { kind: 'authority_unreachable' };
}
