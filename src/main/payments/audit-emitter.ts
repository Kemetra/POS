/**
 * T132 — 006 audit emitter (Slice 3 implementation).
 *
 * Emits the 4 attempt-level + 3 per-line audit categories that extend
 * 004's `audit_events` catalogue per data-model §"Extension to 004's
 * `audit_events`". The emitter is **owned by 006** (its category set
 * extends 004's closed enum, which 006 is not authorised to extend at
 * the type level in S3b — those `as const` definitions live in
 * `src/shared/audit/event-shape.ts`, outside our allowed paths).
 *
 * The emitter delegates persistence to an injected sink so the bridge
 * handlers (S3c) can wire it to 004's `audit_events` table at the
 * trust-boundary layer; tests inject an in-memory capture sink.
 *
 * SECURITY (Constitution §P6 / §P7 / §P11):
 *
 *   1. `external_reference` is **redacted to `*****`** in every emitted
 *      payload (data-model §"Extension to 004's audit_events" table row
 *      for `tender.applied`).
 *   2. Voucher tokens (`voucher_redemption_intent_token`, `voucher_code`)
 *      are **stripped entirely** — they never reach this layer; if a
 *      caller mistakenly passes one via `emitRaw`, the
 *      `FORBIDDEN_PAYLOAD_KEYS` recursive scan refuses the call.
 *   3. PII / card data: the emitter has no field-level allowlist; instead
 *      it relies on the closed-set typed entry points
 *      (`emitPaymentSettled` etc.) to control which fields cross. The
 *      `emitRaw` escape hatch is gated by `FORBIDDEN_PAYLOAD_KEYS`.
 *   4. **`attribution_operator_id` MUST be Clerk-backed** (Constitution
 *      §VIII; FR-013 / FR-014). The `deriveAttributionOperatorId` helper
 *      enforces this at the seam between 004's session manager and 006's
 *      emitter; passing any other identity source is refused with
 *      `AttributionError`.
 */

import { FORBIDDEN_PAYLOAD_KEYS } from '../../shared/audit/forbidden-keys.js';
import type {
  PaymentAuditCategory,
  TenderType,
  FailureReason,
  RefusalReason,
} from '../../shared/payments/types.js';

// ── Emitter input shapes (closed-set typed payloads) ────────────────────────

interface BaseAuditContext {
  tenant_id: string;
  branch_id: string;
  originating_terminal_id: string;
  session_id: string | null;
  attribution_operator_id: string;
}

export interface EmitPaymentSettledInput extends BaseAuditContext {
  payment_attempt_id: string;
  cart_id: string;
  handoff_action_id: string;
  settled_at: string;
  /**
   * Human-readable selling-operator name, sourced from the live operator
   * session at confirm-time. Persisted into the payload so 008's finalize
   * worker (T094b) can stamp it onto the durable Sale row even when it
   * dispatches session-independently during boot recovery (T112) — there
   * is no durable operator_id → display_name lookup table. Not a forbidden
   * field; `sales.selling_operator_display_name` is NOT NULL (migration 0020).
   */
  selling_operator_display_name: string;
  /**
   * RT-224 step 2 — the `users.id` of the admitted cashier who made the sale,
   * for Backend-Core's device-path `captureSale` (`operatorUserId`). Set only when
   * the confirming session is that cashier (payments-confirm); omitted otherwise,
   * and then the key is absent from the payload. An internal provider-neutral
   * UUID, not PII (the `operator.cashier_pin.provisioned` payload already carries
   * one as `target_cashier_id`). Read back per sale by
   * `sales-sync/selling-user-id.ts`.
   */
  selling_user_id?: string;
  tender_lines: readonly EmitTenderLineBreakdown[];
}

export interface EmitTenderLineBreakdown {
  tender_line_id: string;
  tender_type: TenderType;
  amount_applied_minor: number;
  change_due_minor?: number;
  external_reference?: string;
  applied_at: string;
  attribution_operator_id: string;
}

export interface EmitPaymentCancelledInput extends BaseAuditContext {
  payment_attempt_id: string;
  cart_id: string;
  handoff_action_id: string;
  cancelled_at: string;
}

export interface EmitPaymentFailedInput extends BaseAuditContext {
  payment_attempt_id: string;
  cart_id: string;
  handoff_action_id: string;
  failed_at: string;
  failure_reason: FailureReason;
}

export interface EmitTenderAppliedInput extends BaseAuditContext {
  tender_line_id: string;
  payment_attempt_id: string;
  tender_type: TenderType;
  amount_applied_minor: number;
  change_due_minor?: number;
  external_reference?: string;
  applied_at: string;
}

export interface EmitTenderRefusedInput extends BaseAuditContext {
  tender_line_id: string;
  payment_attempt_id: string;
  tender_type: TenderType;
  refusal_reason: RefusalReason;
  refused_at: string;
}

export interface EmitTenderReversedInput extends BaseAuditContext {
  tender_line_id: string;
  payment_attempt_id: string;
  tender_type: TenderType;
  reversed_at: string;
  manual_void_required: boolean;
  /**
   * Wave 5 T231 — optional history preservation for incident reconstruction.
   * The deferred-reversal resolver (and the synchronous `tender.reverse`
   * voucher path when a previously-pending line is finally resolved)
   * passes the original `reversal_pending_since` timestamp here so the
   * `tender.reversed` audit payload preserves the full timeline. The
   * row state's `reversal_pending_since` column is cleared on the
   * `reversal_pending → reversed` transition (data-model.md §"PaymentTenderLine"
   * line 156); the audit_events row keeps it (append-only).
   *
   * Omit on the synchronous `applied → reversed` happy path (cashier
   * undo on a still-`applied` line) where there was never a pending
   * outage to preserve.
   */
  reversal_pending_since?: string;
}

/**
 * Slice 4 voucher path — emitted when a voucher tender line cannot be
 * reversed synchronously (Data-Pulse-2 unreachable on `vouchers.reverse`,
 * or `vouchers.redeem` failed authority_unreachable on `payments.confirm`).
 * The line transitions to `reversal_pending` and the deferred-reversal
 * resolver (Wave 5, T270) retries until success.
 *
 * Category ratified by T204 / migration 0018; F-A4B brief §3.6 + §3.8.
 */
export interface EmitTenderReversalPendingInput extends BaseAuditContext {
  tender_line_id: string;
  payment_attempt_id: string;
  tender_type: TenderType;
  reversal_pending_since: string;
}

// ── Emitter event shape (sink-facing) ───────────────────────────────────────

/**
 * 006-emitter-side event. Not the same type as 004's `AuditEvent` because
 * 006's category set is a strict superset that we cannot encode at the
 * shared-type level in S3b. The bridge handlers (S3c) map this to 004's
 * `AuditEvent` shape and forward to `audit_events.insertIgnore`.
 */
export interface PaymentAuditEvent {
  action_category: PaymentAuditCategory;
  payment_attempt_id: string;
  attribution_operator_id: string;
  tenant_id: string;
  branch_id: string;
  originating_terminal_id: string;
  session_id: string | null;
  created_at: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface PaymentAuditSink {
  write(event: PaymentAuditEvent): void;
}

export interface PaymentAuditEmitterDependencies {
  sink: PaymentAuditSink;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class ForbiddenPaymentAuditKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`payment audit emitter: payload contains forbidden field name: ${key}`);
    this.name = 'ForbiddenPaymentAuditKeyError';
    this.key = key;
  }
}

export class AttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributionError';
  }
}

// ── Attribution helper (FR-013 / FR-014 / Constitution §VIII) ───────────────

/**
 * Accepts a Clerk-backed `OperatorSession` projection only. Every other
 * shape is refused. This is the SINGLE seam where 006 derives the
 * `attribution_operator_id` — bridge handlers in S3c MUST route through
 * this helper rather than pass `operator_id` strings of unknown origin.
 */
export interface AttributionSource {
  readonly kind: 'operator_session';
  readonly operator_id: string;
}

export function deriveAttributionOperatorId(source: AttributionSource): string {
  // The function is typed against AttributionSource but the runtime guard is
  // load-bearing — callers pass `as never` from FR-013 negative tests and
  // from any future seam that hasn't been ported yet.
  const candidate = source as unknown;
  if (candidate === null || typeof candidate !== 'object') {
    throw new AttributionError(
      'attribution_operator_id: source must be a Clerk-backed OperatorSession',
    );
  }
  const obj = candidate as { kind?: unknown; operator_id?: unknown };
  if (obj.kind !== 'operator_session') {
    const k = typeof obj.kind === 'string' ? obj.kind : 'unknown';
    throw new AttributionError(
      `attribution_operator_id: refusing derivation from kind="${k}"; only operator_session is permitted (Constitution §VIII / FR-013 / FR-014)`,
    );
  }
  if (typeof obj.operator_id !== 'string' || obj.operator_id.length === 0) {
    throw new AttributionError(
      'attribution_operator_id: operator_session.operator_id must be a non-empty string',
    );
  }
  return obj.operator_id;
}

// ── Emitter ─────────────────────────────────────────────────────────────────

export interface PaymentAuditEmitter {
  emitPaymentSettled(input: EmitPaymentSettledInput): void;
  emitPaymentCancelled(input: EmitPaymentCancelledInput): void;
  emitPaymentFailed(input: EmitPaymentFailedInput): void;
  emitTenderApplied(input: EmitTenderAppliedInput): void;
  emitTenderRefused(input: EmitTenderRefusedInput): void;
  emitTenderReversed(input: EmitTenderReversedInput): void;
  /**
   * Slice 4 voucher path. Emits `tender.reversal_pending` when the
   * deferred-reversal resolver still owes a successful reverse to V-A
   * (research §R-13). Wired by `payments.confirm` (T261) and
   * `tender.reverse` (T262) when V-A returns `authority_unreachable`.
   */
  emitTenderReversalPending(input: EmitTenderReversalPendingInput): void;
  /**
   * Escape hatch for the bridge handlers that need to forward custom
   * payloads (e.g., `payment.force_failed` in Slice 4). Refuses any
   * payload whose tree contains a `FORBIDDEN_PAYLOAD_KEYS` field at any
   * nesting depth. Slice 3 callers use the typed helpers above; the
   * negative tests in T092/T094 exercise this path.
   */
  emitRaw(event: PaymentAuditEvent): void;
}

export function createPaymentAuditEmitter(
  deps: PaymentAuditEmitterDependencies,
): PaymentAuditEmitter {
  const { sink } = deps;

  function findForbiddenKey(node: unknown): string | null {
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = findForbiddenKey(item);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(key)) {
          return key;
        }
        if (PAYMENT_FORBIDDEN_KEYS.has(key)) return key;
        const hit = findForbiddenKey((node as Record<string, unknown>)[key]);
        if (hit !== null) return hit;
      }
    }
    return null;
  }

  function emit(event: PaymentAuditEvent): void {
    const forbidden = findForbiddenKey(event.payload);
    if (forbidden !== null) {
      throw new ForbiddenPaymentAuditKeyError(forbidden);
    }
    sink.write(event);
  }

  function redactedLineBreakdown(line: EmitTenderLineBreakdown): Record<string, unknown> {
    const out: Record<string, unknown> = {
      tender_line_id: line.tender_line_id,
      tender_type: line.tender_type,
      amount_applied_minor: line.amount_applied_minor,
      applied_at: line.applied_at,
      attribution_operator_id: line.attribution_operator_id,
    };
    if (line.tender_type === 'cash' && line.change_due_minor !== undefined) {
      out.change_due_minor = line.change_due_minor;
    }
    if (line.tender_type === 'external_card_terminal' && line.external_reference !== undefined) {
      out.external_reference = '*****';
    }
    return out;
  }

  return {
    emitPaymentSettled(input: EmitPaymentSettledInput): void {
      emit({
        action_category: 'payment.settled',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.settled_at,
        payload: {
          payment_attempt_id: input.payment_attempt_id,
          cart_id: input.cart_id,
          handoff_action_id: input.handoff_action_id,
          settled_at: input.settled_at,
          attribution_operator_id: input.attribution_operator_id,
          selling_operator_display_name: input.selling_operator_display_name,
          ...(input.selling_user_id === undefined
            ? {}
            : { selling_user_id: input.selling_user_id }),
          tender_lines: input.tender_lines.map(redactedLineBreakdown),
        },
      });
    },

    emitPaymentCancelled(input: EmitPaymentCancelledInput): void {
      emit({
        action_category: 'payment.cancelled',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.cancelled_at,
        payload: {
          payment_attempt_id: input.payment_attempt_id,
          cart_id: input.cart_id,
          handoff_action_id: input.handoff_action_id,
          cancelled_at: input.cancelled_at,
          attribution_operator_id: input.attribution_operator_id,
        },
      });
    },

    emitPaymentFailed(input: EmitPaymentFailedInput): void {
      emit({
        action_category: 'payment.failed',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.failed_at,
        payload: {
          payment_attempt_id: input.payment_attempt_id,
          cart_id: input.cart_id,
          handoff_action_id: input.handoff_action_id,
          failed_at: input.failed_at,
          failure_reason: input.failure_reason,
          attribution_operator_id: input.attribution_operator_id,
        },
      });
    },

    emitTenderApplied(input: EmitTenderAppliedInput): void {
      const payload: Record<string, unknown> = {
        tender_line_id: input.tender_line_id,
        payment_attempt_id: input.payment_attempt_id,
        tender_type: input.tender_type,
        amount_applied_minor: input.amount_applied_minor,
        applied_at: input.applied_at,
        attribution_operator_id: input.attribution_operator_id,
      };
      if (input.tender_type === 'cash' && input.change_due_minor !== undefined) {
        payload.change_due_minor = input.change_due_minor;
      }
      if (
        input.tender_type === 'external_card_terminal' &&
        input.external_reference !== undefined
      ) {
        payload.external_reference = '*****';
      }
      emit({
        action_category: 'tender.applied',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.applied_at,
        payload,
      });
    },

    emitTenderRefused(input: EmitTenderRefusedInput): void {
      emit({
        action_category: 'tender.refused',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.refused_at,
        payload: {
          tender_line_id: input.tender_line_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_type: input.tender_type,
          refusal_reason: input.refusal_reason,
          refused_at: input.refused_at,
          attribution_operator_id: input.attribution_operator_id,
        },
      });
    },

    emitTenderReversed(input: EmitTenderReversedInput): void {
      const payload: Record<string, unknown> = {
        tender_line_id: input.tender_line_id,
        payment_attempt_id: input.payment_attempt_id,
        tender_type: input.tender_type,
        reversed_at: input.reversed_at,
        attribution_operator_id: input.attribution_operator_id,
        manual_void_required: input.manual_void_required,
      };
      // T231 — preserve the original reversal_pending_since for incident
      // reconstruction when the deferred-reversal resolver (or the
      // tender.reverse voucher path on a previously-pending line)
      // resolves the row.
      if (input.reversal_pending_since !== undefined) {
        payload.reversal_pending_since = input.reversal_pending_since;
      }
      emit({
        action_category: 'tender.reversed',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.reversed_at,
        payload,
      });
    },

    emitTenderReversalPending(input: EmitTenderReversalPendingInput): void {
      emit({
        action_category: 'tender.reversal_pending',
        payment_attempt_id: input.payment_attempt_id,
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.reversal_pending_since,
        payload: {
          tender_line_id: input.tender_line_id,
          payment_attempt_id: input.payment_attempt_id,
          tender_type: input.tender_type,
          reversal_pending_since: input.reversal_pending_since,
          attribution_operator_id: input.attribution_operator_id,
        },
      });
    },

    emitRaw(event: PaymentAuditEvent): void {
      emit(event);
    },
  };
}

// ── Payment-specific forbidden keys (in addition to 004's catalogue) ────────

/**
 * Voucher tokens and the like — never permitted in audit payloads even
 * via the `emitRaw` escape hatch. Defence-in-depth against accidental
 * token leakage if a Slice 4 caller forgets to strip.
 */
const PAYMENT_FORBIDDEN_KEYS = new Set(['voucher_redemption_intent_token', 'voucher_code']);
