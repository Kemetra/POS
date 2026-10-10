/**
 * 004-operator-session T013 — Audit-event shape (FR-025 + FR-026 + AD-3).
 *
 * The five mandatory attributes of every audit event are codified here
 * so any future emitter MUST honour them. The shape lands in S1 as a
 * type-only contract; the durable `audit_events` table + emitter
 * (T045–T046) is S3 territory under §A1 / §A3.
 *
 * The `OperatorRefusal` envelope is the canonical "generic refusal"
 * shape that crosses the bridge for every refused operator-bridge call
 * (NFR-003 / PR-2). It carries a closed-set category and NO
 * factor-distinguishing payload — the renderer renders the generic
 * Surface 6 message family from the category alone.
 */

/**
 * Action categories recognised by the audit catalogue (data-model.md §
 * "Action Category Catalogue"). 004 owns the operator/session and PIN /
 * forced-close categories; future features add more.
 */
export const AUDIT_ACTION_CATEGORIES = [
  'shift.open',
  'shift.close',
  'shift.forced_close',
  'operator.session.takeover',
  // RT-117 (RT-116 §7.3) — inactivity lock of the EXISTING session and its
  // same-operator unlock. Neither ends the session.
  'operator.session.locked',
  'operator.session.unlocked',
  // RT-113 P1.2 (OD10) — an offline grant was invalidated or purged. One event
  // per grant, attributed to that grant's operator; payload `{reason}` only.
  // Main-only (a renderer cannot forge it). Open-set at the SQL layer (0004).
  'operator.offline_grant.invalidated',
  'cashier.pin.reset',
  'cashier.pin.unlock',
  // 019-cashier-pin-provisioning (R-2) — first-PIN create path; sibling to
  // reset/unlock. Emitter wiring lands with the provision handler.
  'cashier.pin.provisioned',
  // 005-sales-cart §A3 (FR-026 / Q5) — type-only extension; emitter wiring lands in S3.
  'cart.handoff_to_payment',
  'cart.cancel.post_handoff',
  'cart.discount.above_threshold',
  // Kept (the catalogue never shrinks) but no longer emitted: RT-115 D5
  // superseded the 005 Q3 discard; a draft is held instead (RT-352).
  'cart.discarded_on_session_end',
  // RT-352 (RT-116 §7.3) — a draft cart outlives its session (RT-115 D3.2).
  'cart.held_on_session_end',
  'cart.reattached',
  // RT-26 — Checkout Back: a handed-off cart with no tender activity returns
  // to `editing` (envelope invalidated). Open-set at the SQL layer (0004).
  'cart.return_to_sale',
  // 008-sale-finalization-and-receipts §AD-9 (S1c T093) — 10 new categories.
  // Migration 0026 is a no-op SELECT 1; the closed-set enforcement lives here.
  'sale.finalized',
  'sale.finalization_refused',
  'sale.receipt.printed',
  'sale.receipt.reprinted',
  'sale.receipt.print_failed',
  'sale.receipt.print_retried_success',
  'sale.receipt.manual_override',
  'sale.drawer.opened',
  'sale.drawer.suppressed',
  'sale.drawer.failed',
  // RT-15 S2 — cashier returns (AC11). Open-set at the SQL layer (0004); the
  // categories are recorded in migration 0039's header.
  'sale.return.attempted',
  'sale.return.refused',
  'sale.return.confirmed',
  'sale.return.payout_ready',
  // RT-15 S4 — the cash payout, its drawer kick and the return slip. Open-set
  // at the SQL layer (0004); recorded in migration 0040's header.
  'sale.return.payout_started',
  'sale.return.drawer_opened',
  'sale.return.drawer_failed',
  'sale.return.paid_out',
  'sale.return.slip_printed',
  'sale.return.slip_print_failed',
  'sale.return.slip_reprinted',
  // RT-215 (RT-138 P-1) — the device credential was confirmed revoked, and a
  // later re-pair (or, RT-215 10897-A, a "Check again" answered 2xx) cleared it. System-attributed (no operator acts): the
  // actor is SYSTEM_DEVICE_ACTOR_ID below. Payload `{ source }` only — never a
  // token or device secret. Main-only (the renderer cannot emit them).
  // Open-set at the SQL layer (0004: no CHECK); recorded in migration 0042's
  // header.
  'pairing.device_revoked',
  'pairing.device_revoked_cleared',
] as const;
export type ActionCategory = (typeof AUDIT_ACTION_CATEGORIES)[number];

/**
 * RT-215 / Jira RT-215 comment 10879 (audit actor, branch 2) — the reserved
 * `acting_operator_id` for audit events that no operator performs: the
 * device-revoked pairing events. There was no existing system-actor
 * convention, and `audit_events.acting_operator_id` is free TEXT NOT NULL with
 * no FK (0004), so a named sentinel is used instead of a fake operator row.
 *
 * It cannot collide with a real operator id: those are provider subjects
 * (Clerk `user_<base62>`) or `users.id` UUIDs, neither of which can contain a
 * `:`. Used ONLY by the `pairing.device_revoked*` categories.
 */
export const SYSTEM_DEVICE_ACTOR_ID = 'system:device' as const;

/**
 * The FR-025 mandatory five attributes plus the optional `session_id`,
 * `approving_supervisor_id`, and per-category `payload`. `shift_id` is
 * nullable because some categories (e.g., `operator.session.takeover`)
 * are not shift-scoped per data-model.md.
 */
export interface AuditEvent {
  /** Client-generated UUID v4 (P5 idempotency key). */
  event_id: string;
  /** Opaque tenant identifier. */
  tenant_id: string;
  /** Opaque branch identifier. */
  branch_id: string;
  /** Opaque terminal identifier (FR-025). */
  originating_terminal_id: string;
  /** Clerk user id of the acting operator (FR-025). */
  acting_operator_id: string;
  /** Operator session id; null for events emitted outside a session. */
  session_id: string | null;
  /** Shift id; null for non-shift-scoped categories per data-model.md. */
  shift_id: string | null;
  /** Closed-set category (FR-026). */
  action_category: ActionCategory;
  /** ISO 8601 UTC timestamp (FR-025). */
  created_at: string;
  /** Optional second identity for supervisor-approved actions. */
  approving_supervisor_id: string | null;
  /**
   * Per-category structured payload. Forbidden field names (raw
   * cardholder data, full PII, credential fragments, PIN values,
   * Clerk JWTs, session tokens) MUST be refused at the emitter (T046).
   */
  payload: Readonly<Record<string, unknown>>;
}

/**
 * The five mandatory attributes per FR-025. Used by validators in S3.
 */
export const FR025_MANDATORY_ATTRIBUTES = [
  'acting_operator_id',
  'originating_terminal_id',
  'created_at',
  'action_category',
  'shift_id',
] as const;
export type Fr025MandatoryAttribute = (typeof FR025_MANDATORY_ATTRIBUTES)[number];

/**
 * Generic-refusal categories. ONE category per failure mode; the
 * renderer maps to a single generic Surface-6 message family per
 * outcome (NFR-003 / PR-2).
 *
 * `rate_limited` is the sole exception that distinguishes itself
 * (PR-2 explicit carve-out for the cashier-PIN lockout case; visible
 * to the operator so they know to wait). Reachable in S4; harmless
 * to enumerate here.
 *
 * `not_ready` (019-cashier-pin-provisioning FR-11) is the truthful
 * "cannot provision yet" state: the rostered cashier carries no
 * provider-neutral `user_id`, so provisioning refuses rather than
 * falling back to a provider-coupled key. A degraded-state signal
 * (P9), distinct from `invalid_input` — the request was well-formed,
 * the upstream identity simply isn't available.
 */
export const REFUSAL_CATEGORIES = [
  'invalid_input',
  'no_connection',
  'rate_limited',
  'role_mismatch',
  'not_signed_in',
  'state_invalid',
  'not_ready',
] as const;
export type RefusalCategory = (typeof REFUSAL_CATEGORIES)[number];

export interface OperatorRefusal {
  kind: 'refused';
  category: RefusalCategory;
}

export class OperatorRefusalError extends Error {
  readonly category: RefusalCategory;
  constructor(category: RefusalCategory) {
    super(`operator refusal: ${category}`);
    this.name = 'OperatorRefusalError';
    this.category = category;
  }
}

export function isOperatorRefusal(value: unknown): value is OperatorRefusal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as { kind?: unknown; category?: unknown };
  return (
    v.kind === 'refused' &&
    typeof v.category === 'string' &&
    (REFUSAL_CATEGORIES as readonly string[]).includes(v.category)
  );
}
