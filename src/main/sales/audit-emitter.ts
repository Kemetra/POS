/**
 * T093 — 008 audit emitter (Slice 1c implementation).
 *
 * Emits the 008-side audit categories per AD-9 + data-model.md §"audit_events
 * extension". Mirrors the structure of 006's `createPaymentAuditEmitter`
 * (src/main/payments/audit-emitter.ts) for consistency.
 *
 * Scope of THIS file (Slice 1c only): `emitSaleFinalized`,
 * `emitSaleFinalizationRefused`, and the `emitRaw` escape hatch. The eight
 * remaining 008 categories (receipt.printed / reprinted / print_failed /
 * print_retried_success / manual_override / drawer.opened / suppressed /
 * failed) are added in Slices 2/3/4 alongside their callers — speculative
 * authoring now would be untested dead code.
 *
 * SECURITY (Constitution §P6 / §P7 / §P11):
 *
 *   1. `external_reference` is **substituted with `*****`** in every emitted
 *      sale.finalized payload (per data-model.md §"sale.finalized payload";
 *      mirrors 006 tender.applied at src/main/payments/audit-emitter.ts:299).
 *
 *   2. Voucher tokens, raw envelope bodies, secret credentials, raw card
 *      data, issuer names, and PIN record ids are **refused entirely** — they
 *      never appear in sale audit payloads. The recursive `findForbiddenKey`
 *      scan composes 004's shared `FORBIDDEN_PAYLOAD_KEYS` with the
 *      008-local `SALES_FORBIDDEN_KEYS` set below.
 *
 *   3. `attribution_operator_id` MUST be Clerk-backed (Constitution §VIII;
 *      FR-013 / FR-014). 008 reuses 006's `deriveAttributionOperatorId`
 *      helper at the AD-2 listener seam (T091); this emitter accepts the
 *      already-derived string.
 */

import { findForbiddenKey } from '../audit/find-forbidden-key.js';
import { redactTenderLine } from './redact-tender-line.js';
import type { SalesTenderType, SaleFinalizationRefusalReason } from '../../shared/sales/types.js';

// ─── 008 audit category unions ──────────────────────────────────────────────
//
// The full 10-category list is in src/shared/audit/event-shape.ts under
// AUDIT_ACTION_CATEGORIES.
//
// We expose TWO unions here. The full one (`SaleAuditCategory`) types the
// internal sink-facing event shape so the closed-set entry points
// (`emitSaleFinalized` / `emitSaleFinalizationRefused`) compile against the
// matching event categories. The narrower one (`SaleRawAuditCategory`)
// types the `emitRaw` escape hatch — it OMITS the two categories whose
// only valid emit path is through their typed entry points, so the type
// system prevents a caller from bypassing `emitSaleFinalized`'s
// `external_reference` substitution or `emitSaleFinalizationRefused`'s
// closed-set refusal-reason routing. A runtime guard inside `emitRaw`
// repeats the check as defence in depth in case a caller uses `as` to
// narrow past the type system (per CR1 on PR #264).

export type SaleAuditCategory =
  | 'sale.finalized'
  | 'sale.finalization_refused'
  | 'sale.receipt.printed'
  | 'sale.receipt.reprinted'
  | 'sale.receipt.print_failed'
  | 'sale.receipt.print_retried_success'
  | 'sale.receipt.manual_override'
  | 'sale.drawer.opened'
  | 'sale.drawer.suppressed'
  | 'sale.drawer.failed';

export type SaleRawAuditCategory = Exclude<
  SaleAuditCategory,
  'sale.finalized' | 'sale.finalization_refused'
>;

const EMIT_RAW_FORBIDDEN_CATEGORIES = new Set<SaleAuditCategory>([
  'sale.finalized',
  'sale.finalization_refused',
]);

// ─── Emitter input shapes (closed-set typed payloads) ───────────────────────

interface BaseAuditContext {
  tenant_id: string;
  branch_id: string;
  originating_terminal_id: string;
  session_id: string | null;
  attribution_operator_id: string;
}

/**
 * Tender-line summary as it appears in the `sale.finalized` audit payload.
 * Mirrors the persisted `tender_lines_summary_json` shape (data-model.md
 * §"Entity: Sale") but stripped of card-data / voucher-token fields per
 * FR-070..FR-074. `external_reference` is permitted here on the way in;
 * the emitter substitutes `*****` before writing.
 */
export interface EmitSaleTenderLine {
  tender_type: SalesTenderType;
  amount_applied_minor: number;
  change_due_minor?: number;
  external_reference?: string;
}

export interface EmitSaleFinalizedInput extends BaseAuditContext {
  sale_id: string;
  sale_number: string;
  payment_attempt_id: string;
  envelope_handoff_action_id: string;
  finalized_at: string;
  subtotal_minor: number;
  total_tax_minor: number;
  tender_lines_summary: readonly EmitSaleTenderLine[];
}

export interface EmitSaleFinalizationRefusedInput extends BaseAuditContext {
  envelope_handoff_action_id: string;
  refused_at: string;
  refusal_reason: SaleFinalizationRefusalReason;
}

// ─── Emitter event shape (sink-facing) ──────────────────────────────────────

export interface SaleAuditEvent {
  action_category: SaleAuditCategory;
  attribution_operator_id: string;
  tenant_id: string;
  branch_id: string;
  originating_terminal_id: string;
  session_id: string | null;
  created_at: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface SaleAuditSink {
  write(event: SaleAuditEvent): void;
}

export interface SaleAuditEmitterDependencies {
  sink: SaleAuditSink;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class ForbiddenSaleAuditKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`sale audit emitter: payload contains forbidden field name: ${key}`);
    this.name = 'ForbiddenSaleAuditKeyError';
    this.key = key;
  }
}

// ─── 008-local forbidden-key set (composed with 004's shared list) ──────────
//
// Per FR-070..FR-074 + CodeRabbit CR3 on PR #261. Voucher tokens, raw
// envelope bodies, issuer names, PIN record ids, and a few keys that 004's
// list does not enumerate (because 004 is operator-session scoped and never
// sees voucher / envelope vocabulary).

const SALES_FORBIDDEN_KEYS = new Set<string>([
  // FR-071 — voucher
  'voucher_code',
  'voucher_balance',
  'voucher_redemption_intent_token',
  'authority_payload',
  // FR-074 — raw envelope
  'envelope_payload',
  'raw_envelope',
  // FR-072 — secret credentials beyond 004's shared list
  'jwt',
  // CR3 on PR #261 — card / authoriser identity
  'issuer_name',
  'pin_record_id',
  // FR-073 — voucher authority handoff
  'envelope_handoff_action_id_raw',
]);

// ─── Emitter ────────────────────────────────────────────────────────────────

/**
 * Narrowed sink event for `emitRaw`. The category is restricted to the 8
 * S2/S3/S4-bound categories; the two finalize-namespace categories are
 * unreachable here at compile time. The runtime guard inside emitRaw
 * checks the same invariant for defence in depth.
 */
export interface SaleRawAuditEvent {
  action_category: SaleRawAuditCategory;
  attribution_operator_id: string;
  tenant_id: string;
  branch_id: string;
  originating_terminal_id: string;
  session_id: string | null;
  created_at: string;
  payload: Readonly<Record<string, unknown>>;
}

export class EmitRawForbiddenCategoryError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(`emitRaw refused: category "${category}" must be emitted via its typed entry point`);
    this.name = 'EmitRawForbiddenCategoryError';
    this.category = category;
  }
}

export interface SaleAuditEmitter {
  emitSaleFinalized(input: EmitSaleFinalizedInput): void;
  emitSaleFinalizationRefused(input: EmitSaleFinalizationRefusedInput): void;
  /**
   * Escape hatch for future 008 emit methods (S2/S3/S4) and for negative
   * tests. Refuses any payload whose tree contains a forbidden field name
   * at any nesting depth — combines 004's shared `FORBIDDEN_PAYLOAD_KEYS`
   * with the 008-local `SALES_FORBIDDEN_KEYS` set above.
   *
   * Categories `sale.finalized` and `sale.finalization_refused` are
   * REFUSED here (both at compile time via `SaleRawAuditCategory` and at
   * runtime via `EMIT_RAW_FORBIDDEN_CATEGORIES`) — their only valid emit
   * path is through the typed entry points above so the inline
   * `external_reference` redaction and closed-set refusal-reason routing
   * cannot be bypassed.
   */
  emitRaw(event: SaleRawAuditEvent): void;
}

export function createSaleAuditEmitter(deps: SaleAuditEmitterDependencies): SaleAuditEmitter {
  const { sink } = deps;

  function emit(event: SaleAuditEvent): void {
    const forbidden = findForbiddenKey(event.payload, SALES_FORBIDDEN_KEYS);
    if (forbidden !== null) {
      throw new ForbiddenSaleAuditKeyError(forbidden);
    }
    sink.write(event);
  }

  return {
    emitSaleFinalized(input: EmitSaleFinalizedInput): void {
      emit({
        action_category: 'sale.finalized',
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.finalized_at,
        payload: {
          sale_id: input.sale_id,
          sale_number: input.sale_number,
          payment_attempt_id: input.payment_attempt_id,
          envelope_handoff_action_id: input.envelope_handoff_action_id,
          finalized_at: input.finalized_at,
          subtotal_minor: input.subtotal_minor,
          total_tax_minor: input.total_tax_minor,
          attribution_operator_id: input.attribution_operator_id,
          tender_lines_summary: input.tender_lines_summary.map(redactTenderLine),
        },
      });
    },

    emitSaleFinalizationRefused(input: EmitSaleFinalizationRefusedInput): void {
      emit({
        action_category: 'sale.finalization_refused',
        attribution_operator_id: input.attribution_operator_id,
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        originating_terminal_id: input.originating_terminal_id,
        session_id: input.session_id,
        created_at: input.refused_at,
        payload: {
          envelope_handoff_action_id: input.envelope_handoff_action_id,
          refused_at: input.refused_at,
          refusal_reason: input.refusal_reason,
          attribution_operator_id: input.attribution_operator_id,
        },
      });
    },

    emitRaw(event: SaleRawAuditEvent): void {
      // Defence-in-depth: even if a caller used `as` to narrow past the
      // SaleRawAuditCategory union, refuse the call rather than let it
      // bypass the typed-entry-point redaction discipline (CR1).
      if (EMIT_RAW_FORBIDDEN_CATEGORIES.has(event.action_category)) {
        throw new EmitRawForbiddenCategoryError(event.action_category);
      }
      emit(event);
    },
  };
}
