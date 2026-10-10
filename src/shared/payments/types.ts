/**
 * T072 — 006 Slice 3b shared payment types.
 *
 * Closed enums + canonical unions consumed by both the main process and
 * the renderer through `src/shared/bridge-api.ts`. The values mirror
 * `specs/006-payments-tender/data-model.md` + `contracts/bridge-api.md`
 * and are the single source of truth for the Slice-3 surface.
 *
 * Constitution §VII (no leakage): only display-safe / structural values
 * appear here. Voucher tokens, intent tokens, PINs, Clerk JWTs, and
 * device tokens are never typed in this module.
 *
 * **Closed-set discipline.** Each exported `as const` tuple drives a
 * derived union; tests assert exhaustive membership at runtime. Adding
 * a value requires updating both the tuple here and every consumer's
 * exhaustive-switch table.
 */

// ── PaymentAttempt FSM states (5) ────────────────────────────────────────────

export const PAYMENT_ATTEMPT_STATES = [
  'started',
  'settled',
  'cancelled',
  'failed',
  'force_failed',
] as const;
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

// ── TenderLine FSM states (5) ────────────────────────────────────────────────

export const TENDER_LINE_STATES = [
  'applying',
  'applied',
  'refused',
  'reversed',
  'reversal_pending',
] as const;
export type TenderLineState = (typeof TENDER_LINE_STATES)[number];

// ── TenderType (3) ───────────────────────────────────────────────────────────

export const TENDER_TYPES = ['cash', 'external_card_terminal', 'internal_voucher'] as const;
export type TenderType = (typeof TENDER_TYPES)[number];

// ── FailureReason (14) — FR-006 closed enum ──────────────────────────────────

export const FAILURE_REASONS = [
  'cart_lost',
  'operator_session_terminated',
  'dependency_unavailable',
  'internal_error',
  'stale_handoff',
  'tender_underpaid',
  'non_cash_overpayment_refused',
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
  'split_tender_rollback',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

// ── RefusalReason — closed union for bridge-side `{ kind: 'refused', reason }` ─

export const REFUSAL_REASONS = [
  // Session / role / ownership (mirrors 004 / 005 patterns).
  'no_session',
  'role_denied',
  'wrong_owner',
  'tenant_isolation',
  // Envelope / cart linkage.
  'cart_lost',
  'stale_handoff',
  // Attempt-level invariants.
  'attempt_already_started_on_terminal',
  'attempt_terminal',
  'tender_underpaid',
  // RT-339: a cash apply on an attempt with nothing left to pay.
  'attempt_fully_tendered',
  'internal_error',
  // Idempotency (R-10).
  'idempotency_payload_mismatch',
  // Per-line refusals.
  'invalid_input',
  'non_cash_overpayment_refused',
  'tender_not_yet_supported',
  'line_not_applied',
  'dependency_unavailable',
  // Voucher refusals — typed Slice-3 for forward use; Slice-4 wires the validate / redeem paths.
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// ── Refusal envelope (mirrors 005 cart-refusal shape per AD-3 / R-2) ─────────

export interface PaymentRefusal {
  readonly kind: 'refused';
  readonly reason: RefusalReason;
}

// ── Audit-event categories introduced by 006 (4 attempt-level + 4 per-line) ──

export const PAYMENT_AUDIT_CATEGORIES = [
  'payment.settled',
  'payment.cancelled',
  'payment.failed',
  'payment.force_failed',
  'tender.applied',
  'tender.refused',
  'tender.reversed',
  // Slice 4 only — typed here for the audit-emitter; emission is gated.
  'tender.reversal_pending',
] as const;
export type PaymentAuditCategory = (typeof PAYMENT_AUDIT_CATEGORIES)[number];

// ── Renderer-minimised projections (FR-017) ──────────────────────────────────

/**
 * Per-line view sent to the renderer through `payments.subscribe` /
 * `payments.read` / `tender.read`. **No voucher_redemption_intent_token**;
 * voucher_authority_redemption_id is the only voucher-side string that
 * crosses (opaque, FR-017).
 */
export interface TenderLineRendererView {
  readonly tender_line_id: string;
  readonly tender_type: TenderType;
  readonly amount_applied_minor: number;
  readonly change_due_minor?: number;
  readonly external_reference?: string;
  readonly voucher_authority_redemption_id?: string;
  readonly state: TenderLineState;
  readonly applied_at?: string;
  readonly refused_at?: string;
  readonly reversed_at?: string;
  readonly reversal_pending_since?: string;
  readonly refusal_reason?: RefusalReason;
  readonly apply_order: number;
}

/**
 * Attempt-level renderer view. Holds the immutable envelope subtotal +
 * the per-line array. Voucher tokens never appear here (FR-017).
 */
export interface PaymentAttemptRendererView {
  readonly payment_attempt_id: string;
  readonly state: PaymentAttemptState;
  readonly envelope_subtotal_minor: number;
  readonly started_at: string;
  readonly settled_at?: string;
  readonly cancelled_at?: string;
  readonly failed_at?: string;
  readonly force_failed_at?: string;
  readonly tender_lines: readonly TenderLineRendererView[];
}
