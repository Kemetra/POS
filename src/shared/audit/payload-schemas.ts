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
  operation: 'lookup' | 'quote' | 'submit' | 'resolve' | 'list' | 'payout' | 'reprint';
  reason: string;
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
 * paid out. `kick_outcome` says what is known: `failed_before_send` (provably
 * never reached the drawer) or `unknown` (timeout / fault: may have opened).
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
  method: 'drawer' | 'manual';
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
  // RT-113 P1.2 (OD10)
  'operator.offline_grant.invalidated': OperatorOfflineGrantInvalidatedPayload;
  'cashier.pin.reset': CashierPinResetPayload;
  'cashier.pin.unlock': CashierPinUnlockPayload;
  'cashier.pin.provisioned': CashierPinProvisionedPayload;
  // 005-sales-cart §A3 (FR-026 / Q5)
  'cart.handoff_to_payment': CartHandoffToPaymentPayload;
  'cart.cancel.post_handoff': CartCancelPostHandoffPayload;
  'cart.discount.above_threshold': CartDiscountAboveThresholdPayload;
  'cart.discarded_on_session_end': CartDiscardedOnSessionEndPayload;
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
  // RT-215
  'pairing.device_revoked': PairingDeviceRevokedPayload;
  'pairing.device_revoked_cleared': PairingDeviceRevokedClearedPayload;
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
