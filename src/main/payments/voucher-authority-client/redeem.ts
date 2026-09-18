/**
 * 006 T251 — `vouchers.redeem` HTTP client (GREEN).
 *
 * Calls `POST /api/pos/v1/vouchers/redeem` against Data-Pulse-2 and
 * maps the response into the same `{ kind: 'redeemed' | 'refused' |
 * 'authority_unreachable' }` envelope shape used by `validateVoucher`.
 *
 * Mutating endpoint — `Idempotency-Key` MUST be supplied by the
 * caller and is the same key reused across the matched
 * `validate` → `redeem` pair (the OpenAPI contract supports replay
 * with `idempotent_replayed: true`).
 *
 * **Redaction (FR-017):** the request `redemption_intent_token` and
 * the response `redemption_id` are never stringified into log
 * arguments. Only the structured `error.code` is propagated on
 * refusal.
 */
import type { components } from '../../../shared/api-types.js';

import { extractErrorCode } from './error-body.js';
import {
  mapRefusalCode,
  type VoucherAuthorityLogger,
  type VoucherRefusalReason,
} from './refusal-mapping.js';

function isRedeemedResponse(raw: unknown): raw is RedeemVoucherOk {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'redeemed';
}

export type RedeemVoucherInput = components['schemas']['PosRedeemVoucherRequest'];
export type RedeemVoucherOk = components['schemas']['PosRedeemVoucherResponse'];

export type RedeemVoucherOutcome =
  | RedeemVoucherOk
  | { kind: 'refused'; reason: VoucherRefusalReason }
  | { kind: 'authority_unreachable' };

export interface RedeemVoucherDeps {
  baseUrl: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  logger: VoucherAuthorityLogger;
  /** Caller-generated UUID v4 — replays MUST reuse the same key. */
  idempotencyKey: string;
  timeoutMs?: number;
}

const REDEEM_PATH = '/api/pos/v1/vouchers/redeem';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function redeemVoucher(
  input: RedeemVoucherInput,
  deps: RedeemVoucherDeps,
): Promise<RedeemVoucherOutcome> {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await deps.fetch(`${root}${REDEEM_PATH}`, {
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
      { endpoint: 'redeem', outcome: 'authority_unreachable' },
      'voucher_authority:transport_failure',
    );
    return { kind: 'authority_unreachable' };
  }

  if (response.ok) {
    try {
      const raw = (await response.json()) as unknown;
      if (isRedeemedResponse(raw)) return raw;
      deps.logger.warn(
        { endpoint: 'redeem', reason: 'malformed_success_body' },
        'voucher_authority:malformed_response',
      );
      return { kind: 'authority_unreachable' };
    } catch {
      deps.logger.warn(
        { endpoint: 'redeem', reason: 'json_parse_failure' },
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
        { endpoint: 'redeem', reason: 'missing_error_code', status: response.status },
        'voucher_authority:refused_no_code',
      );
      return { kind: 'refused', reason: 'validation_failure' };
    }
    const reason = mapRefusalCode(code, 'redeem', deps.logger);
    return { kind: 'refused', reason };
  }

  deps.logger.warn(
    { endpoint: 'redeem', status: response.status, outcome: 'authority_unreachable' },
    'voucher_authority:non_ok_response',
  );
  return { kind: 'authority_unreachable' };
}
