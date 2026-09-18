/**
 * 006 T252 — `vouchers.reverse` HTTP client (GREEN).
 *
 * Calls `POST /api/pos/v1/vouchers/reverse` against Data-Pulse-2 and
 * maps the response into the same `{ kind: 'reversed' | 'refused' |
 * 'authority_unreachable' }` envelope shape used by the sibling
 * clients.
 *
 * **R-13 deferred-reversal posture:** on `authority_unreachable` the
 * Wave-4 FSM consumer is responsible for transitioning the tender line
 * to `reversal_pending`. This client MUST NOT call into
 * `src/main/payments/fsm/*` directly — it only returns the sentinel.
 *
 * **Redaction (FR-017):** no token-shaped strings cross the bridge to
 * the renderer; the request body carries only the `redemption_id`
 * which is allow-listed by FR-017. The raw response body is still
 * never logged.
 */
import type { components } from '../../../shared/api-types.js';

import { extractErrorCode } from './error-body.js';
import {
  mapRefusalCode,
  type VoucherAuthorityLogger,
  type VoucherRefusalReason,
} from './refusal-mapping.js';

function isReversedResponse(raw: unknown): raw is ReverseVoucherOk {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'reversed';
}

export type ReverseVoucherInput = components['schemas']['PosReverseVoucherRequest'];
export type ReverseVoucherOk = components['schemas']['PosReverseVoucherResponse'];

export type ReverseVoucherOutcome =
  | ReverseVoucherOk
  | { kind: 'refused'; reason: VoucherRefusalReason }
  | { kind: 'authority_unreachable' };

export interface ReverseVoucherDeps {
  baseUrl: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  logger: VoucherAuthorityLogger;
  idempotencyKey: string;
  timeoutMs?: number;
}

const REVERSE_PATH = '/api/pos/v1/vouchers/reverse';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function reverseVoucher(
  input: ReverseVoucherInput,
  deps: ReverseVoucherDeps,
): Promise<ReverseVoucherOutcome> {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await deps.fetch(`${root}${REVERSE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': deps.idempotencyKey,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    deps.logger.warn(
      { endpoint: 'reverse', outcome: 'authority_unreachable' },
      'voucher_authority:transport_failure',
    );
    return { kind: 'authority_unreachable' };
  }

  if (response.ok) {
    try {
      const raw = (await response.json()) as unknown;
      if (isReversedResponse(raw)) return raw;
      deps.logger.warn(
        { endpoint: 'reverse', reason: 'malformed_success_body' },
        'voucher_authority:malformed_response',
      );
      return { kind: 'authority_unreachable' };
    } catch {
      deps.logger.warn(
        { endpoint: 'reverse', reason: 'json_parse_failure' },
        'voucher_authority:malformed_response',
      );
      return { kind: 'authority_unreachable' };
    }
  }

  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 401 &&
    response.status !== 425
  ) {
    let code: string | undefined;
    try {
      const raw = (await response.json()) as unknown;
      code = extractErrorCode(raw);
    } catch {
      // fall through
    }
    if (!code) {
      deps.logger.warn(
        { endpoint: 'reverse', reason: 'missing_error_code', status: response.status },
        'voucher_authority:refused_no_code',
      );
      return { kind: 'refused', reason: 'validation_failure' };
    }
    const reason = mapRefusalCode(code, 'reverse', deps.logger);
    return { kind: 'refused', reason };
  }

  deps.logger.warn(
    { endpoint: 'reverse', status: response.status, outcome: 'authority_unreachable' },
    'voucher_authority:non_ok_response',
  );
  return { kind: 'authority_unreachable' };
}
