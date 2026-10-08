/**
 * RT-304 — the single definition of "what an action's idempotency hash covers".
 *
 * The idempotency helper checks a retry's hash BEFORE the FSM runs, and the
 * FSM writes the outbox row's hash AFTER. If the two are computed from
 * different shapes, a same-key retry finds the row, compares unequal hashes
 * and is refused as `idempotency_payload_mismatch` — the replay branch of every
 * handler becomes unreachable. This module is the one place both sides take
 * the shape from, so they cannot drift apart again.
 *
 * Rules every payload builder follows:
 *   • It contains only what the CALLER'S REQUEST determines. Anything minted
 *     per call (`payment_attempt_id` on start, `tender_line_id` on apply) or
 *     produced by the FSM (cancel's `reversed_tender_line_ids`, a voucher
 *     authority's capped amount) is excluded, because a retry cannot
 *     reproduce it before the FSM runs.
 *   • Redaction is applied here, once, at the hash boundary (Constitution
 *     §P6 / §P7): `external_reference` is replaced with a fixed marker and
 *     voucher tokens/codes are stripped, whatever the tender type.
 */

import {
  computeActionPayloadHash,
  type PaymentActionKind,
} from './repositories/payment-action-outbox.repository.js';
import type { TenderType } from '../../shared/payments/types.js';

// ── Redaction (Constitution §P6 / §P7 / §P11) ───────────────────────────────

/**
 * Fields whose values are replaced with `'*****'` before hashing. Each is a
 * structural pointer: the field's presence is hashed, its content is not.
 * `external_reference` is regex-bounded but redacted defensively (FR-008).
 */
const REDACT_KEYS = new Set(['external_reference']);

/**
 * Fields removed entirely before hashing. Voucher tokens must never take part
 * in an outbox row's hash: the row is also a defence-in-depth layer against
 * token leakage in audit / log dumps.
 */
const STRIP_KEYS = new Set([
  'voucher_redemption_intent_token',
  'voucher_code',
  'voucher_authority_redemption_id',
]);

export function redactPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactPayload);
  if (payload !== null && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(payload)) {
      if (STRIP_KEYS.has(key)) continue;
      const value = (payload as Record<string, unknown>)[key];
      out[key] = REDACT_KEYS.has(key) ? '*****' : redactPayload(value);
    }
    return out;
  }
  return payload;
}

/** The hash stored on the outbox row and compared on every same-key retry. */
export function hashActionPayload(action_kind: PaymentActionKind, payload: unknown): string {
  return computeActionPayloadHash({ action_kind, payload: redactPayload(payload) });
}

// ── Per-action payloads ─────────────────────────────────────────────────────

export function startActionPayload(input: {
  envelope_handoff_action_id: string;
  envelope_cart_id: string;
  envelope_subtotal_minor: number;
}): Record<string, unknown> {
  return {
    envelope_handoff_action_id: input.envelope_handoff_action_id,
    envelope_cart_id: input.envelope_cart_id,
    envelope_subtotal_minor: input.envelope_subtotal_minor,
  };
}

/** `payment.confirm`, `payment.cancel` and `payment.force_fail` share this. */
export function attemptActionPayload(input: {
  payment_attempt_id: string;
}): Record<string, unknown> {
  return { payment_attempt_id: input.payment_attempt_id };
}

export function failActionPayload(input: {
  payment_attempt_id: string;
  failure_reason: string;
}): Record<string, unknown> {
  return {
    payment_attempt_id: input.payment_attempt_id,
    failure_reason: input.failure_reason,
  };
}

/**
 * `amount_applied_minor` is the REQUESTED amount, not what the line persists:
 * a voucher authority may cap the persisted value, but the retry carries the
 * request, so the request is what must be hashed.
 */
export function tenderApplyActionPayload(input: {
  payment_attempt_id: string;
  tender_type: TenderType;
  amount_applied_minor: number;
  external_reference?: string | undefined;
  voucher_code?: string | undefined;
}): Record<string, unknown> {
  return {
    payment_attempt_id: input.payment_attempt_id,
    tender_type: input.tender_type,
    amount_applied_minor: input.amount_applied_minor,
    ...(input.external_reference !== undefined
      ? { external_reference: input.external_reference }
      : {}),
    ...(input.voucher_code !== undefined ? { voucher_code: input.voucher_code } : {}),
  };
}

export function tenderReverseActionPayload(input: {
  tender_line_id: string;
  payment_attempt_id: string;
}): Record<string, unknown> {
  return {
    tender_line_id: input.tender_line_id,
    payment_attempt_id: input.payment_attempt_id,
  };
}
