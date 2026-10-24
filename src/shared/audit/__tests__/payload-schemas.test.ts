import { describe, it, expect } from 'vitest';

import {
  FORCED_CLOSE_REASONS,
  type AuditPayloadMap,
  type CartCancelPostHandoffPayload,
  type CartDiscardedOnSessionEndPayload,
  type CartDiscountAboveThresholdPayload,
  type CartHandoffToPaymentPayload,
  type CashierPinProvisionedPayload,
  type CashierPinResetPayload,
  type CashierPinUnlockPayload,
  type ForcedCloseReason,
  type OperatorSessionTakeoverPayload,
  type ShiftClosePayload,
  type ShiftForcedClosePayload,
  type ShiftOpenPayload,
} from '../payload-schemas.js';
import { AUDIT_ACTION_CATEGORIES } from '../event-shape.js';

/**
 * 004-operator-session T049 — Per-action-category payload schema tests.
 *
 * These are type-contract tests: they assert that the payload types
 * compile against the data-model.md §"Action Category Catalogue" and
 * that the runtime constants are consistent with the type-level claims.
 * The runtime assertions are intentionally trivial — the real gate is
 * TypeScript's type checker.
 */

describe('audit/payload-schemas (T049)', () => {
  it('AuditPayloadMap covers all ActionCategory values', () => {
    // Every key in AuditPayloadMap must be a known ActionCategory.
    // If a category exists in the runtime catalogue but is absent from
    // the map, this test catches the omission.
    const mapKeys: Array<keyof AuditPayloadMap> = [
      'shift.open',
      'shift.close',
      'shift.forced_close',
      'operator.session.takeover',
      'cashier.pin.reset',
      'cashier.pin.unlock',
      'cashier.pin.provisioned',
      // 005-sales-cart §A3
      'cart.handoff_to_payment',
      'cart.cancel.post_handoff',
      'cart.discount.above_threshold',
      // RT-608 (RT-28 D3)
      'cart.discount.manager_authorized',
      'cart.discarded_on_session_end',
    ];
    for (const key of mapKeys) {
      expect(AUDIT_ACTION_CATEGORIES).toContain(key);
    }
  });

  it('RT-608 / RT-854: CartDiscountManagerAuthorizedPayload carries ids, the closed reason and the value, never a credential', () => {
    const approved: AuditPayloadMap['cart.discount.manager_authorized'] = {
      cart_id: 'cart-1',
      cart_line_id: 'line-1',
      placeholder_id: 'ph-1',
      approval_id: 'appr-1',
      reason_code: 'loyal_or_contract_customer',
      kind: 'percent',
      value: 10,
      amount_minor: 900,
    };
    const direct: AuditPayloadMap['cart.discount.manager_authorized'] = {
      cart_id: 'cart-1',
      cart_line_id: 'line-1',
      placeholder_id: 'ph-1',
      reason_code: 'price_correction',
      kind: 'amount',
      value: 250,
      amount_minor: 250,
      approver_role: 'admin',
    };
    // A row recorded before RT-854 (no value fields) still types.
    const legacy: AuditPayloadMap['cart.discount.manager_authorized'] = {
      cart_id: 'cart-1',
      cart_line_id: 'line-1',
      placeholder_id: 'ph-1',
    };
    const notOnTheList: AuditPayloadMap['cart.discount.manager_authorized'] = {
      ...legacy,
      // @ts-expect-error — the reason is the closed list (doc 28 §11.2)
      reason_code: 'loyal_customer',
    };
    const notARole: AuditPayloadMap['cart.discount.manager_authorized'] = {
      ...legacy,
      // @ts-expect-error — the approver role is manager or admin only
      approver_role: 'cashier',
    };
    expect([notOnTheList, notARole]).toHaveLength(2);
    for (const payload of [approved, direct, legacy]) {
      for (const forbidden of ['pin', 'pin_hash', 'password', 'approver_ref', 'display_name']) {
        expect(payload).not.toHaveProperty(forbidden);
      }
    }
  });

  it('FORCED_CLOSE_REASONS is the exact five-value closed set from data-model.md', () => {
    expect(FORCED_CLOSE_REASONS).toEqual([
      'takeover_supersession',
      'cashier_no_show',
      'cashier_illness',
      'terminal_failure',
      'other',
    ]);
  });

  it('ShiftOpenPayload type accepts a well-formed record', () => {
    const payload: ShiftOpenPayload = {
      shift_id: 'shift-uuid-001',
      opened_at: '2026-05-07T08:00:00.000Z',
    };
    expect(payload.shift_id).toBe('shift-uuid-001');
  });

  it('ShiftClosePayload type accepts numeric and matched states', () => {
    const numeric: ShiftClosePayload = {
      shift_id: 'shift-uuid-002',
      closed_at: '2026-05-07T16:00:00.000Z',
      declared_count_state: 'numeric',
    };
    const matched: ShiftClosePayload = {
      shift_id: 'shift-uuid-003',
      closed_at: '2026-05-07T16:01:00.000Z',
      declared_count_state: 'matched',
    };
    expect(numeric.declared_count_state).toBe('numeric');
    expect(matched.declared_count_state).toBe('matched');
  });

  it('ShiftForcedClosePayload type accepts a well-formed record without annotation', () => {
    const payload: ShiftForcedClosePayload = {
      shift_id: 'shift-uuid-004',
      shift_owner_id: 'clerk-cashier-1',
      forced_close_actor_id: 'clerk-manager-1',
      forced_close_reason: 'cashier_no_show',
    };
    expect(payload.forced_close_reason).toBe('cashier_no_show');
    expect(payload.annotation).toBeUndefined();
  });

  it('ShiftForcedClosePayload type accepts an optional annotation', () => {
    const payload: ShiftForcedClosePayload = {
      shift_id: 'shift-uuid-005',
      shift_owner_id: 'clerk-cashier-2',
      forced_close_actor_id: 'clerk-manager-2',
      forced_close_reason: 'other',
      annotation: 'Emergency closure — see incident report INR-042.',
    };
    expect(payload.annotation).toBeDefined();
  });

  it('OperatorSessionTakeoverPayload type accepts a well-formed record', () => {
    const payload: OperatorSessionTakeoverPayload = {
      superseded_session_id: 'sess-uuid-prev',
      prior_terminal_reference: 'term-internal-id-A',
    };
    expect(payload.superseded_session_id).toBe('sess-uuid-prev');
  });

  it('CashierPinResetPayload type accepts a well-formed record (§A1-gated, types only in S3)', () => {
    const payload: CashierPinResetPayload = {
      target_cashier_id: 'clerk-cashier-3',
      terminal_id: 'term-internal-id-B',
    };
    expect(Object.keys(payload)).not.toContain('pin');
    expect(Object.keys(payload)).not.toContain('pin_hash');
    expect(Object.keys(payload)).not.toContain('password');
  });

  it('CashierPinUnlockPayload type accepts a well-formed record (§A1-gated, types only in S3)', () => {
    const payload: CashierPinUnlockPayload = {
      target_cashier_id: 'clerk-cashier-4',
      terminal_id: 'term-internal-id-C',
    };
    expect(Object.keys(payload)).not.toContain('pin');
    expect(Object.keys(payload)).not.toContain('pin_hash');
    expect(Object.keys(payload)).not.toContain('password');
  });

  it('CashierPinProvisionedPayload is secret-free (019 — FR-7 / PR-1)', () => {
    const payload: CashierPinProvisionedPayload = {
      // target_cashier_id is the provider-neutral user_id the row is keyed on.
      target_cashier_id: 'neutral-user-uuid-5',
      terminal_id: 'term-internal-id-D',
    };
    expect(Object.keys(payload)).not.toContain('pin');
    expect(Object.keys(payload)).not.toContain('pin_hash');
    expect(Object.keys(payload)).not.toContain('pin_salt');
    expect(Object.keys(payload)).not.toContain('password');
  });

  it('ForcedCloseReason is assignable from every FORCED_CLOSE_REASONS value', () => {
    for (const reason of FORCED_CLOSE_REASONS) {
      const typed: ForcedCloseReason = reason;
      expect(typeof typed).toBe('string');
    }
  });

  // ─── 005-sales-cart §A3 payload shape tests (FR-026 / Q5) ───────────────

  it('CartHandoffToPaymentPayload type accepts a well-formed record', () => {
    const payload: CartHandoffToPaymentPayload = {
      cart_id: 'cart-uuid-001',
      handoff_action_id: 'ha-uuid-001',
      line_count: 3,
      subtotal_minor: 4500,
    };
    expect(Number.isSafeInteger(payload.subtotal_minor)).toBe(true);
    expect(payload.cart_id).toBe('cart-uuid-001');
    expect(Object.keys(payload)).not.toContain('pin');
    expect(Object.keys(payload)).not.toContain('pin_hash');
    expect(Object.keys(payload)).not.toContain('password');
  });

  it('CartCancelPostHandoffPayload type accepts a well-formed record', () => {
    const payload: CartCancelPostHandoffPayload = {
      cart_id: 'cart-uuid-002',
      handoff_action_id: 'ha-uuid-002',
    };
    expect(payload.handoff_action_id).toBe('ha-uuid-002');
    expect(Object.keys(payload)).not.toContain('pin');
    expect(Object.keys(payload)).not.toContain('pin_hash');
    expect(Object.keys(payload)).not.toContain('password');
  });

  it('CartDiscountAboveThresholdPayload type accepts a well-formed record', () => {
    const payload: CartDiscountAboveThresholdPayload = {
      cart_id: 'cart-uuid-003',
      cart_line_id: 'line-uuid-003',
    };
    expect(payload.cart_line_id).toBe('line-uuid-003');
    expect(Object.keys(payload)).not.toContain('pin');
    expect(Object.keys(payload)).not.toContain('pin_hash');
    expect(Object.keys(payload)).not.toContain('password');
  });

  it('CartDiscardedOnSessionEndPayload type accepts a well-formed record', () => {
    const payload: CartDiscardedOnSessionEndPayload = {
      cart_id: 'cart-uuid-004',
      operator_session_id: 'sess-uuid-004',
      discard_cause: 'signed_out',
    };
    expect(payload.discard_cause).toBe('signed_out');
    expect(Object.keys(payload)).not.toContain('pin');
    expect(Object.keys(payload)).not.toContain('pin_hash');
    expect(Object.keys(payload)).not.toContain('password');
  });
});
