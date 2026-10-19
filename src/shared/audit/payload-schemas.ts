/**
 * 004-operator-session T049 — Per-action-category payload schemas.
 *
 * Type-only definitions for the `payload` field of each `AuditEvent`
 * action category (data-model.md §"Action Category Catalogue").
 *
 * Rules (FR-027 / PR-1):
 *   - PIN values MUST NEVER appear in any payload field.
 *   - Raw cardholder data, full PII, credential fragments, and session
 *     tokens MUST NEVER appear in any payload field.
 *   - The emitter (T046, S3) enforces these rules at the bridge-handler
 *     insertion point; these types are the structural complement.
 *
 * The §A1-gated categories (`cashier.pin.reset`, `cashier.pin.unlock`)
 * ship here as types only; their handlers land in S4.
 */

import type { SessionEndCause } from '../operator/session-end-cause.js';
import type { ActionCategory } from './event-shape.js';
import type { SaleFinalizationRefusalReason } from '../sales/types.js';
import type { DeviceRevokedSource } from '../pairing-types.js';

// ─── shift.open ────────────────────────────────────────────────────────────

export interface ShiftOpenPayload {
  /** FK into shifts table. */
  shift_id: string;
  /** ISO 8601 UTC timestamp the shift was opened. */
  opened_at: string;
}

// ─── shift.close ───────────────────────────────────────────────────────────

export interface ShiftClosePayload {
  /** FK into shifts table. */
  shift_id: string;
  /** ISO 8601 UTC timestamp the shift was closed. */
  closed_at: string;
  /**
   * Whether the cashier entered a numeric count or used the
   * "matched" shortcut. The actual integer value lives on the Shift
   * row (drawer-math field), not in the audit payload — the audit
   * records only *that* a close happened and which declaration mode
   * was used (FR-024 blind-close discipline).
   */
  declared_count_state: 'numeric' | 'matched';
}

// ─── shift.forced_close ────────────────────────────────────────────────────

export const FORCED_CLOSE_REASONS = [
  'takeover_supersession',
  'cashier_no_show',
  'cashier_illness',
  'terminal_failure',
  'other',
] as const;
export type ForcedCloseReason = (typeof FORCED_CLOSE_REASONS)[number];

export interface ShiftForcedClosePayload {
  /** FK into shifts table. */
  shift_id: string;
  /** Clerk user id of the absent cashier whose shift is being closed. */
  shift_owner_id: string;
  /**
   * Clerk user id of the executing manager / admin.
   * Mirrors `acting_operator_id` on the AuditEvent envelope; duplicated
   * here so the payload is self-contained for the SC-005 review.
   */
  forced_close_actor_id: string;
  /** Structured reason — MUST be set; free-text annotation is a supplement, not a replacement. */
  forced_close_reason: ForcedCloseReason;
  /**
   * Optional free-text annotation for support context. MUST NOT
   * contain PIN values, credential fragments, or raw PII (PR-1 /
   * FR-027). The emitter validates forbidden field names.
   */
  annotation?: string;
}

// ─── operator.session.locked / unlocked (RT-117) ───────────────────────────

/**
 * `operator.session.locked` — the EXISTING session locked in place
 * (RT-115 D1). The session is not ended; no money or cart is touched.
 */
export interface OperatorSessionLockedPayload {
  /** Why it locked. `manual` is reserved (RT-115 left the shortcut undecided). */
  lock_cause: 'inactivity';
}

/**
 * `operator.session.unlocked` — same-operator unlock of the same session.
 * No credential, PIN or identifier is recorded (P11).
 */
export interface OperatorSessionUnlockedPayload {
  /** Milliseconds the session spent locked. */
  locked_duration_ms: number;
}

/**
 * `operator.signin.refused_unresolved_payment` (RT-444, RT-116 §4) — empty on
 * purpose: the refusal names neither the other operator nor any amount
 * (FR-013). The event's own attribution records who was refused, where.
 */
export type OperatorSigninRefusedUnresolvedPaymentPayload = Record<string, never>;

// ─── manager recovery (RT-441, RT-116 §5.2) ─────────────────────────────────

/** `cart.held_cancelled_by_manager` — ids and closed values only; never a label. */
export interface CartHeldCancelledByManagerPayload {
  cart_id: string;
  approval_id: string;
  kind: 'draft' | 'handed_off';
  parked: boolean;
}

/** `cart.parked` (RT-440, spec 024 K6) — ids and counts; never the label text. */
export interface CartParkedPayload {
  cart_id: string;
  line_count: number;
  total_minor: number;
  has_label: boolean;
}

/** `cart.resumed` (RT-440, spec 024 K6). `current_cart` says what happened to the current sale. */
export interface CartResumedPayload {
  cart_id: string;
  parked_for_ms: number;
  price_changes_accepted: number;
  removed_unavailable: number;
  current_cart: 'none' | 'parked';
}

/** `cart.park_refused` (RT-440, spec 024 K6) — the closed reason only. */
export interface CartParkRefusedPayload {
  reason: 'not_parkable' | 'park_limit_reached' | 'wrong_owner' | 'invalid_label';
}

/** `payment.recovery_completed` — the stuck sale was finished by a manager. */
export interface PaymentRecoveryCompletedPayload {
  payment_attempt_id: string;
  cart_id: string;
  approval_id: string;
}

/** `payment.recovery_cancelled` — the stuck sale was reversed by a manager. */
export interface PaymentRecoveryCancelledPayload {
  payment_attempt_id: string;
  cart_id: string;
  approval_id: string;
  cash_returned_confirmed: boolean;
  card_void_confirmed_on_terminal: boolean;
}

// ─── operator.offline_grant.invalidated (RT-113 P1.2) ────────────────────────

/**
 * Why an offline grant was invalidated (RT-113 10763 D4, OD6, OD8). Closed
 * set, shared by the grant store and this audit payload.
 */
export const OFFLINE_GRANT_INVALIDATION_REASONS = [
  /** Backend-Core answered 403 for this user. */
  'forbidden',
  /** Backend-Core answered 401 for the device (RT-138 L6). */
  'device_unauthorized',
  /** OD6: the cashier was admitted on another till (`active_elsewhere`). */
  'superseded',
  /** The terminal was paired again. */
  'repair',
  /** The terminal was unpaired. */
  'unpair',
  /** OD8: Backend-Core answered `offline_grace_seconds = 0`. */
  'grace_disabled',
  /** An `admitted` event could not be recorded, so the old grant must not stand. */
  'refresh_failed',
] as const;

export type OfflineGrantInvalidationReason = (typeof OFFLINE_GRANT_INVALIDATION_REASONS)[number];

/**
 * `operator.offline_grant.invalidated` — one event per grant (OD10), attributed
 * to that grant's operator through `acting_operator_id`. The reason only: no
 * grant field (user id, admission id, display name, times) is ever recorded.
 */
export interface OperatorOfflineGrantInvalidatedPayload {
  reason: OfflineGrantInvalidationReason;
}

// ─── operator.session.takeover ─────────────────────────────────────────────

export interface OperatorSessionTakeoverPayload {
  /** Session id of the session that was superseded on the prior terminal. */
  superseded_session_id: string;
  /**
   * Opaque internal reference to the prior terminal. MUST NOT be a
   * user-visible terminal label — only an internal id (FR-013 minimum-
   * disclosure guarantee). The renderer MUST NOT receive or display this.
   */
  prior_terminal_reference: string;
}

// ─── cashier.pin.reset (§A1-gated; handler lands in S4) ───────────────────

export interface CashierPinResetPayload {
  /** Clerk user id of the cashier whose PIN is being reset. */
  target_cashier_id: string;
  /** Terminal id on which the PIN record lives (PR-4 per-terminal scope). */
  terminal_id: string;
  // PIN value MUST NEVER appear here (PR-1 / FR-027).
  [key: string]: unknown;
}

// ─── cashier.pin.unlock (§A1-gated; handler lands in S4) ──────────────────

export interface CashierPinUnlockPayload {
  /** Clerk user id of the locked-out cashier being unlocked. */
  target_cashier_id: string;
  /** Terminal id on which the lockout state lives (PR-4 per-terminal scope). */
  terminal_id: string;
  // PIN value MUST NEVER appear here (PR-1 / FR-027).
  [key: string]: unknown;
}

// ─── cashier.pin.provisioned (019-cashier-pin-provisioning, R-2) ──────────

/**
 * Emitted when a manager/admin provisions a cashier's FIRST PIN (create path).
 * Scope + fact only — mirrors `CashierPinResetPayload` exactly. Carries NO
 * secret (no PIN, hash, or salt — FR-7 / P7). `target_cashier_id` is the
 * provider-neutral `user_id` the row is born keyed on (028 §16).
 */
export interface CashierPinProvisionedPayload {
  /** Provider-neutral `user_id` of the cashier whose first PIN was provisioned. */
  target_cashier_id: string;
  /** Terminal id on which the PIN record lives (PR-4 per-terminal scope). */
  terminal_id: string;
  // PIN value MUST NEVER appear here (PR-1 / FR-027).
  [key: string]: unknown;
}

// ─── 005-sales-cart §A3 categories (type-only; emitters land in S3) ──────

/**
 * `cart.handoff_to_payment` — emitted when a draft cart hands off to the
 * future payment / checkout feature (spec FR-026, AC #6). Manager
 * attribution is NOT required for the handoff itself; the cashier
 * attribution lives on the AuditEvent envelope. Subtotal is in integer
 * minor units (NFR-002); the emitter MUST enforce `Number.isSafeInteger`.
 */
export interface CartHandoffToPaymentPayload {
  /** FK into carts table. */
  cart_id: string;
  /** UUID v4 of the cart_action_outbox row whose action_kind = cart.handoff_to_payment. */
  handoff_action_id: string;
  /** Non-negative count of non-removed cart lines at handoff. */
  line_count: number;
  /** Integer minor units; MUST satisfy Number.isSafeInteger at emit time. */
  subtotal_minor: number;
}

/**
 * `cart.cancel.post_handoff` — manager-attributed cancellation of a cart
 * that has already entered `handed_off_to_payment` (spec FR-033). The
 * cashier is the requester (envelope `acting_operator_id`); the manager
 * is the approver (envelope `approving_supervisor_id`).
 */
export interface CartCancelPostHandoffPayload {
  /** FK into carts table. */
  cart_id: string;
  /** UUID of the prior `cart.handoff_to_payment` outbox row this cancel reverses. */
  handoff_action_id: string;
  /** RT-443 (MA-2): the consumed manager approval, on a cashier's cancel. */
  approval_id?: string;
}

/**
 * `cart.held_on_session_end` (RT-352, RT-116 §3.3) — the session that owned
 * a draft cart ended; the cart is kept for its operator on its terminal
 * (RT-115 D3.2). Ids and the end cause only. `end_cause` is null when the
 * session ended without one.
 */
export interface CartHeldOnSessionEndPayload {
  cart_id: string;
  operator_session_id: string;
  end_cause: SessionEndCause | null;
}

/**
 * `cart.reattached` (RT-352, RT-116 §3.1) — at sign-in, the operator's held
 * draft cart on this terminal was re-bound from its dead session to the new
 * one. Ids only.
 */
export interface CartReattachedPayload {
  cart_id: string;
  from_operator_session_id: string;
  to_operator_session_id: string;
}

/**
 * `cart.return_to_sale` (RT-26) — Checkout Back: a `frozen_handed_off` cart
 * with no tender activity returned to `editing`, its envelope invalidated.
 * Cashier-initiated, no manager attribution. Ids only — no amounts, no lines.
 */
export interface CartReturnToSalePayload {
  /** FK into carts table. */
  cart_id: string;
  /** The `cart.handoff_to_payment` action this Back left (now unusable). */
  handoff_action_id: string;
  /** The zero-funds started attempt cancelled with the Back, or null. */
  cancelled_payment_attempt_id: string | null;
}

/**
 * `cart.discount.manager_authorized` (RT-608, RT-28 FR-023 revised) — a manual
 * discount placeholder authorised by a manager. The requester is the envelope's
 * `acting_operator_id`, the approver its `approving_supervisor_id` (a consumed
 * approval's `users.id`, or the manager / admin session itself under D2).
 * Ids and the closed reason code only: never a PIN, hash or approver name.
 */
export interface CartDiscountManagerAuthorizedPayload {
  /** FK into carts table. */
  cart_id: string;
  /** FK into cart_lines table — the line bearing the discount placeholder. */
  cart_line_id: string;
  /** The placeholder written (its `idempotency_key`). */
  placeholder_id: string;
  /** The consumed `cart.discount.manual` approval; absent when a manager applied directly. */
  approval_id?: string;
  /** The approval's reason code; absent when a manager applied directly. */
  reason_code?: string;
}

/**
 * HISTORICAL ONLY (RT-28 D3): never emitted since RT-608; kept so recorded
 * rows keep their meaning.
 *
 * `cart.discount.above_threshold` — manager-attributed discount placeholder
 * whose magnitude exceeds the Q2 tenant-configured threshold (spec FR-023).
 * The cart layer records only the placeholder; the discounted amount is
 * computed by the future payment / checkout feature. The cashier is the
 * requester; the manager is the approver (envelope `approving_supervisor_id`).
 */
export interface CartDiscountAboveThresholdPayload {
  /** FK into carts table. */
  cart_id: string;
  /** FK into cart_lines table — the line bearing the discount placeholder. */
  cart_line_id: string;
}

/**
 * `cart.discarded_on_session_end` — fires when Q3 policy (a) discards a
 * draft cart on session end (spec Q5 LOCKED 2026-05-14). Non-attributed
 * lifecycle event; the cashier whose session is ending is the
 * `acting_operator_id` on the envelope. `discard_cause` reuses the
 * canonical operator-session end-cause union so the discard reason and
 * the session end cause stay in lockstep.
 */
export interface CartDiscardedOnSessionEndPayload {
  /** FK into carts table. */
  cart_id: string;
  /** Session id whose end triggered the discard. */
  operator_session_id: string;
  /** Reuses the canonical operator-session end-cause union. */
  discard_cause: SessionEndCause;
}

// ─── 008-sale-finalization-and-receipts (AD-9 / Slice 1c T093) ────────────
//
// Ten new categories. The two used by Slice 1c (T091 finalize transaction)
// have shaped payloads; the eight S2/S3/S4-owned categories are declared
// as open-ended records here so the AuditPayloadMap stays exhaustive
// against ActionCategory. The shaped versions land alongside their
// emitting callers — per CLAUDE.md "don't design for hypothetical future
// requirements".

/**
 * `sale.finalized` — fires from `src/main/sales/finalize-transaction.ts`
 * inside the AD-2 atomic finalize transaction. Mirrors
 * `EmitSaleFinalizedInput` minus the redirected attribution / context
 * fields the emitter routes to top-level columns. `external_reference` on
 * card tender lines is substituted to `*****` by the emitter (008 §P11).
 */
export interface SaleFinalizedPayload {
  sale_id: string;
  sale_number: string;
  payment_attempt_id: string;
  envelope_handoff_action_id: string;
  finalized_at: string;
  subtotal_minor: number;
  total_tax_minor: number;
  attribution_operator_id: string;
  tender_lines_summary: ReadonlyArray<{
    tender_type: 'cash' | 'external_card_terminal' | 'internal_voucher';
    amount_applied_minor: number;
    change_due_minor?: number;
    /** Card-terminal reference; redacted to `*****` by the emitter. */
    external_reference?: string;
  }>;
}

/**
 * `sale.finalization_refused` — fires when AD-2 refuses to finalize a
 * settled payment attempt (force_failed / reversal_pending_line /
 * source_attempt_not_settled / forbidden_field_in_tender_summary).
 */
export interface SaleFinalizationRefusedPayload {
  envelope_handoff_action_id: string;
  refused_at: string;
  refusal_reason: SaleFinalizationRefusalReason;
  attribution_operator_id: string;
}

/**
 * Slice 2/3 categories — receipt lifecycle. Shape lands with each
 * category's emitting caller (S3 print pipeline; S5 reprint flow). The
 * placeholder shape locks in the map's exhaustiveness against
 * ActionCategory without prescribing fields that S3/S5 haven't authored
 * yet.
 */
export type SaleReceiptPrintedPayload = Readonly<Record<string, unknown>>;
export type SaleReceiptReprintedPayload = Readonly<Record<string, unknown>>;
export type SaleReceiptPrintFailedPayload = Readonly<Record<string, unknown>>;
export type SaleReceiptPrintRetriedSuccessPayload = Readonly<Record<string, unknown>>;
export type SaleReceiptManualOverridePayload = Readonly<Record<string, unknown>>;

/**
 * Slice 4 categories — drawer lifecycle. Same placeholder posture.
 */
export type SaleDrawerOpenedPayload = Readonly<Record<string, unknown>>;
export type SaleDrawerSuppressedPayload = Readonly<Record<string, unknown>>;
export type SaleDrawerFailedPayload = Readonly<Record<string, unknown>>;

// ─── RT-15 S2 — cashier returns (AC11) ────────────────────────────────────
//
// Operator and terminal ride the envelope (`acting_operator_id`,
// `originating_terminal_id`); the payloads carry the sale / return references
// and minor-unit amounts only. No line names, no free text, no credential.

/** `sale.return.attempted` — the return was journaled and is about to be sent. */
export interface SaleReturnAttemptedPayload {
  return_id: string;
  sale_id: string;
  sale_ref: string;
  quoted_total_minor: number;
  currency_code: string;
  line_count: number;
}

/**
 * `sale.return.refused` — a return was refused, before or after journaling.
 * `return_id` / `sale_id` / `sale_ref` are null when the refusal came before
 * the till knew them (e.g. a cashier refused at lookup).
 */
export interface SaleReturnRefusedPayload {
  return_id: string | null;
  sale_id: string | null;
  sale_ref: string | null;
  operation: 'lookup' | 'quote' | 'submit' | 'resolve' | 'list' | 'payout' | 'reprint' | 'resend';
  reason: string;
}

/**
 * RT-196 S1 — `sale.return.attempt_unknown`: one send left the return unknown.
 * `attempt_no` is the journal's attempt count at that send; `cause` is one of
 * `RETURN_UNKNOWN_CAUSES`; `operation` is how it was sent.
 */
export interface SaleReturnAttemptUnknownPayload {
  return_id: string;
  sale_id: string;
  attempt_no: number;
  cause: string;
  operation: 'submit' | 'resolve' | 'resend';
}

/** RT-196 S1 — `sale.return.resend_requested`: a manager resent one return. */
export interface SaleReturnResendRequestedPayload {
  return_id: string;
}

/** `sale.return.confirmed` — Backend-Core answered 201/200 (a replay counts). */
export interface SaleReturnConfirmedPayload {
  return_id: string;
  sale_id: string;
  sale_ref: string;
  return_ref: string;
  return_total_minor: number;
  currency_code: string;
  replayed: boolean;
}

/** `sale.return.payout_ready` — the confirmed cash refund may be paid out (S4 kicks). */
export interface SaleReturnPayoutReadyPayload {
  return_id: string;
  sale_ref: string;
  return_ref: string;
  payout_minor: number;
  currency_code: string;
  method: 'cash';
}

// ─── RT-15 S4 — the cash payout, drawer and return slip ────────────────────
//
// The acting operator (envelope) is the one who paid out. Amounts are the
// server-confirmed refund in minor units. No slip text, no line names.

/** `sale.return.payout_started` — the payout was claimed, before the drawer kick. */
export interface SaleReturnPayoutStartedPayload {
  return_id: string;
  sale_ref: string;
  return_ref: string;
  payout_minor: number;
  currency_code: string;
}

/** `sale.return.drawer_opened` — the drawer kick reported opened. */
export interface SaleReturnDrawerOpenedPayload {
  return_id: string;
  return_ref: string;
  kick_outcome: 'opened';
}

/**
 * `sale.return.drawer_failed` — the drawer did not report opened; nothing was
 * paid out by the kick. `kick_outcome` says what is known: `failed_before_send`
 * (provably never reached the drawer) or `unknown` (timeout / fault: may have
 * opened). RT-531: with `failure_reason: 'no_drawer_configured'` the terminal has
 * no drawer; the payout is then completed as `no_drawer` (`sale.return.paid_out`
 * follows) and the kick outcome recorded here is the audit of that answer.
 */
export interface SaleReturnDrawerFailedPayload {
  return_id: string;
  return_ref: string;
  failure_reason: string;
  kick_outcome: 'failed_before_send' | 'unknown';
}

/** `sale.return.paid_out` — the cash refund was paid out (once per return). */
export interface SaleReturnPaidOutPayload {
  return_id: string;
  sale_id: string;
  sale_ref: string;
  return_ref: string;
  payout_minor: number;
  currency_code: string;
  /** RT-531: `no_drawer` = paid on a terminal with no cash drawer (no attestation). */
  method: 'drawer' | 'manual' | 'no_drawer';
  tender: 'cash';
}

/** `sale.return.slip_printed` / `slip_reprinted` — a return slip printed (copy on reprint). */
export interface SaleReturnSlipPrintedPayload {
  return_id: string;
  return_ref: string;
}

/** `sale.return.slip_print_failed` — the slip did not print; the payout stands. */
export interface SaleReturnSlipPrintFailedPayload {
  return_id: string;
  return_ref: string;
  copy: boolean;
  failure_reason: string;
}

// ─── pairing.device_revoked / pairing.device_revoked_cleared (RT-215) ──────

/**
 * `{ source }` ONLY (Jira RT-215 comment 10879): the device-bearer route
 * family whose 401 started the confirmed revocation. No token, no device
 * secret, no URL. The actor is `SYSTEM_DEVICE_ACTOR_ID`.
 */
export interface PairingDeviceRevokedPayload {
  source: DeviceRevokedSource;
}

/**
 * `{ source }` ONLY: the revocation was cleared by a successful re-pair
 * (`re_pair`), or by a user-initiated "Check again" the server answered 2xx
 * (`recheck`, RT-215 10897-A / 10906).
 */
export interface PairingDeviceRevokedClearedPayload {
  source: 're_pair' | 'recheck';
}

// ─── manager_credential.* (RT-438, MA-1) ────────────────────────────────────

/**
 * The manager PIN record's opaque handle only: never the PIN, its hash or
 * seal, and never the manager's users.id (the handle stands for it locally).
 */
export interface ManagerCredentialPayload {
  manager_ref: string;
}

/** `manager_credential.revoked` — plus the closed reason (0047). */
export interface ManagerCredentialRevokedPayload extends ManagerCredentialPayload {
  reason: 'self' | 'other_manager' | 'ineligible';
}

// ─── manager_approval.* (RT-443, MA-2) ─────────────────────────────────────

/** `manager_approval.granted` — the approval and what it is for. */
export interface ManagerApprovalGrantedPayload {
  approval_id: string;
  action_kind: string;
  subject_ref: string;
  reason_code: string;
}

// ─── RT-530 — manager-approved sale void ──────────────────────────────────
//
// The requesting operator is the envelope's `acting_operator_id`, the terminal
// its `originating_terminal_id`, the approving manager its
// `approving_supervisor_id` (users.id). Payloads carry the sale, the bound
// amount, the approval and policy and closed codes; never a PIN or envelope.

/** `sale.void.requested` — the approval was consumed and the void journaled. */
export interface SaleVoidRequestedPayload {
  void_id: string;
  sale_id: string;
  amount_minor: number;
  currency_code: string;
  business_date: string;
  approval_id: string;
  policy_version: string;
  approved_at: string;
  requester_user_id: string;
}

/** `sale.void.confirmed` — Backend-Core recorded the void (a replay counts). */
export interface SaleVoidConfirmedPayload {
  void_id: string;
  sale_id: string;
  void_ref: string;
  amount_minor: number;
  currency_code: string;
  replayed: boolean;
}

/** `sale.void.refused` — Backend-Core refused the void; terminal, visible to staff. */
export interface SaleVoidRefusedPayload {
  void_id: string;
  sale_id: string;
  reason: string;
  amount_minor: number;
  currency_code: string;
  approval_id: string;
  policy_version: string;
}

// ─── RT-546 — sales/receipts role gate ────────────────────────────────────

/**
 * `sale.access.refused` — the main-process role gate refused a `sales.*` /
 * `receipts.*` call. The actor is the envelope's `acting_operator_id`. No sale
 * content; `sale_id` only when the refusal was about a specific sale.
 */
export interface SaleAccessRefusedPayload {
  action: string;
  reason: 'role_denied' | 'not_owner';
  sale_id?: string;
}

// ─── RT-551 — sale-number day rule ────────────────────────────────────────

/**
 * `sale.number_day_rule.switched` — the terminal's first sale numbered by the
 * store business day of `finalized_at` (Option A cutover). Written once per
 * terminal; the actor is the device sentinel.
 */
export interface SaleNumberDayRuleSwitchedPayload {
  terminal_id: string;
  sale_id: string;
  sale_number: string;
  finalized_at: string;
  business_day: string;
  time_zone: string;
}

// ─── RT-542 — store-history reprint ───────────────────────────────────────

/**
 * `sale.history.reprinted` — a store-history reprint Backend-Core authorized.
 * The actor is the signed-in operator. `sale_ref` is Backend-Core's opaque sale
 * id; `copy_number` the server's; `outcome` the local print result.
 */
export interface SaleHistoryReprintedPayload {
  sale_ref: string;
  kind: 'duplicate' | 'sale_record';
  copy_number: number;
  marks: ('voided' | 'returned')[];
  outcome: string;
}

/** `manager_approval.refused` — what was asked; never why (C3), never a PIN. */
export interface ManagerApprovalRefusedPayload {
  action_kind: string;
  subject_ref: string;
}

// ─── Discriminated map (ActionCategory → payload type) ────────────────────

/**
 * Maps every `ActionCategory` to its typed payload shape.
 * Consumers use this as `AuditPayloadMap[ActionCategory]` to derive
 * the correct payload type for a given category.
 *
 * Extend this map (and `ActionCategory` in event-shape.ts) when future
 * features introduce new audit categories. MUST NOT shrink the existing
 * entries (FR-026 — catalogue is append-only).
 */
export type AuditPayloadMap = {
  'shift.open': ShiftOpenPayload;
  'shift.close': ShiftClosePayload;
  'shift.forced_close': ShiftForcedClosePayload;
  'operator.session.takeover': OperatorSessionTakeoverPayload;
  // RT-117 (RT-116 §7.3)
  'operator.session.locked': OperatorSessionLockedPayload;
  'operator.session.unlocked': OperatorSessionUnlockedPayload;
  // RT-444 (RT-116 §4)
  'operator.signin.refused_unresolved_payment': OperatorSigninRefusedUnresolvedPaymentPayload;
  // RT-113 P1.2 (OD10)
  'operator.offline_grant.invalidated': OperatorOfflineGrantInvalidatedPayload;
  'cashier.pin.reset': CashierPinResetPayload;
  'cashier.pin.unlock': CashierPinUnlockPayload;
  'cashier.pin.provisioned': CashierPinProvisionedPayload;
  // 005-sales-cart §A3 (FR-026 / Q5)
  'cart.handoff_to_payment': CartHandoffToPaymentPayload;
  'cart.cancel.post_handoff': CartCancelPostHandoffPayload;
  'cart.discount.above_threshold': CartDiscountAboveThresholdPayload;
  'cart.discount.manager_authorized': CartDiscountManagerAuthorizedPayload;
  'cart.discarded_on_session_end': CartDiscardedOnSessionEndPayload;
  // RT-352
  'cart.held_on_session_end': CartHeldOnSessionEndPayload;
  'cart.reattached': CartReattachedPayload;
  // RT-441
  'cart.held_cancelled_by_manager': CartHeldCancelledByManagerPayload;
  // RT-440 (PK-2)
  'cart.parked': CartParkedPayload;
  'cart.resumed': CartResumedPayload;
  'cart.park_refused': CartParkRefusedPayload;
  'payment.recovery_completed': PaymentRecoveryCompletedPayload;
  'payment.recovery_cancelled': PaymentRecoveryCancelledPayload;
  // RT-26
  'cart.return_to_sale': CartReturnToSalePayload;
  // 008-sale-finalization-and-receipts (AD-9 / Slice 1c T093 — shaped;
  // S2/S3/S4 placeholders pending their emitting callers)
  'sale.finalized': SaleFinalizedPayload;
  'sale.finalization_refused': SaleFinalizationRefusedPayload;
  'sale.receipt.printed': SaleReceiptPrintedPayload;
  'sale.receipt.reprinted': SaleReceiptReprintedPayload;
  'sale.receipt.print_failed': SaleReceiptPrintFailedPayload;
  'sale.receipt.print_retried_success': SaleReceiptPrintRetriedSuccessPayload;
  'sale.receipt.manual_override': SaleReceiptManualOverridePayload;
  'sale.drawer.opened': SaleDrawerOpenedPayload;
  'sale.drawer.suppressed': SaleDrawerSuppressedPayload;
  'sale.drawer.failed': SaleDrawerFailedPayload;
  // RT-15 S2
  'sale.return.attempted': SaleReturnAttemptedPayload;
  'sale.return.refused': SaleReturnRefusedPayload;
  'sale.return.confirmed': SaleReturnConfirmedPayload;
  'sale.return.payout_ready': SaleReturnPayoutReadyPayload;
  // RT-15 S4
  'sale.return.payout_started': SaleReturnPayoutStartedPayload;
  'sale.return.drawer_opened': SaleReturnDrawerOpenedPayload;
  'sale.return.drawer_failed': SaleReturnDrawerFailedPayload;
  'sale.return.paid_out': SaleReturnPaidOutPayload;
  'sale.return.slip_printed': SaleReturnSlipPrintedPayload;
  'sale.return.slip_print_failed': SaleReturnSlipPrintFailedPayload;
  'sale.return.slip_reprinted': SaleReturnSlipPrintedPayload;
  // RT-196 S1
  'sale.return.attempt_unknown': SaleReturnAttemptUnknownPayload;
  'sale.return.resend_requested': SaleReturnResendRequestedPayload;
  // RT-215
  'pairing.device_revoked': PairingDeviceRevokedPayload;
  'pairing.device_revoked_cleared': PairingDeviceRevokedClearedPayload;
  // RT-438
  'manager_credential.enrolled': ManagerCredentialPayload;
  'manager_credential.revoked': ManagerCredentialRevokedPayload;
  'manager_credential.locked_out': ManagerCredentialPayload;
  'manager_credential.disabled': ManagerCredentialPayload;
  // RT-443
  'manager_approval.granted': ManagerApprovalGrantedPayload;
  'manager_approval.refused': ManagerApprovalRefusedPayload;
  // RT-530
  'sale.void.requested': SaleVoidRequestedPayload;
  'sale.void.confirmed': SaleVoidConfirmedPayload;
  'sale.void.refused': SaleVoidRefusedPayload;
  // RT-546
  'sale.access.refused': SaleAccessRefusedPayload;
  // RT-551
  'sale.number_day_rule.switched': SaleNumberDayRuleSwitchedPayload;
  // RT-542
  'sale.history.reprinted': SaleHistoryReprintedPayload;
};

// Compile-time assertions: AuditPayloadMap and ActionCategory are in sync.
// If a new category is added to ActionCategory without updating this map,
// or vice-versa, TypeScript will surface a type error on one of these lines.
type _AssertMapCoversCategory =
  AuditPayloadMap extends Record<ActionCategory, unknown> ? true : false;
type _AssertCategoryCoversMap = keyof AuditPayloadMap extends ActionCategory ? true : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _m: _AssertMapCoversCategory = true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _c: _AssertCategoryCoversMap = true;
