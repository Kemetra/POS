/**
 * RT-496 — `settlement-commit.ts` unit coverage: the committer's refusal path
 * and the `payment.settled` tender breakdown. Atomicity on a real database is
 * covered by rt496-atomic-settlement.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  appliedTenderBreakdown,
  createSettlementCommitter,
} from '../../../../src/main/payments/settlement-commit.js';
import type { EmitPaymentSettledInput } from '../../../../src/main/payments/audit-emitter.js';
import type { ConfirmOutcome } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { makeAuditEmitterDouble, makeLineRow } from './__fixtures__/bridge-handler-deps.js';

const SETTLED_AT = '2026-10-15T10:00:00.000Z';

const SETTLED: EmitPaymentSettledInput = {
  payment_attempt_id: 'pa-1',
  cart_id: 'cart-1',
  handoff_action_id: 'handoff-1',
  settled_at: SETTLED_AT,
  attribution_operator_id: 'op-1',
  selling_operator_display_name: 'Mona',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  originating_terminal_id: 'terminal-1',
  session_id: 'sess-1',
  tender_lines: [],
};

function setup(outcome: ConfirmOutcome) {
  const transaction = vi.fn(<T extends (...args: never[]) => unknown>(fn: T): T => fn);
  const confirm = vi.fn(() => outcome);
  const recordSellingOperatorDisplayName = vi.fn();
  const auditEmitter = makeAuditEmitterDouble();
  const committer = createSettlementCommitter({
    db: { transaction },
    paymentAttemptFsm: { confirm },
    attemptsRepo: { recordSellingOperatorDisplayName },
    auditEmitter,
  });
  const input = { payment_attempt_id: 'pa-1', settled_at: SETTLED_AT, action_id: 'k-1' };
  return { committer, input, transaction, confirm, recordSellingOperatorDisplayName, auditEmitter };
}

describe('RT-496 — createSettlementCommitter', () => {
  it('on ok: one transaction settles, freezes the name and writes the audit', () => {
    const s = setup({ kind: 'ok', settled_at: SETTLED_AT });
    expect(s.committer.commit(s.input, SETTLED)).toEqual({ kind: 'ok', settled_at: SETTLED_AT });
    expect(s.transaction).toHaveBeenCalledTimes(1);
    expect(s.confirm).toHaveBeenCalledWith(s.input);
    expect(s.recordSellingOperatorDisplayName).toHaveBeenCalledWith({
      payment_attempt_id: 'pa-1',
      selling_operator_display_name: 'Mona',
    });
    expect(s.auditEmitter.captured.map((e) => e.action_category)).toEqual(['payment.settled']);
  });

  it('on an FSM refusal: passes it through and writes neither the name nor the audit', () => {
    const s = setup({ kind: 'refused', reason: 'tender_underpaid' });
    expect(s.committer.commit(s.input, SETTLED)).toEqual({
      kind: 'refused',
      reason: 'tender_underpaid',
    });
    expect(s.recordSellingOperatorDisplayName).not.toHaveBeenCalled();
    expect(s.auditEmitter.captured).toEqual([]);
  });

  it('builds the event before the transaction opens, so a bad payload writes nothing', () => {
    const s = setup({ kind: 'ok', settled_at: SETTLED_AT });
    s.auditEmitter.buildPaymentSettled = vi.fn(() => {
      throw new Error('forbidden key');
    });
    expect(() => s.committer.commit(s.input, SETTLED)).toThrow('forbidden key');
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.confirm).not.toHaveBeenCalled();
  });
});

describe('RT-496 — appliedTenderBreakdown', () => {
  it('keeps applied lines in apply order with their optional fields; falls back to settled_at', () => {
    const lines = [
      makeLineRow({
        tender_line_id: 'tl-card',
        tender_type: 'external_card_terminal',
        amount_applied_minor: 500,
        external_reference: 'REF-123',
        apply_order: 2,
        applied_at: null,
      }),
      makeLineRow({
        tender_line_id: 'tl-reversed',
        state: 'reversed',
        apply_order: 3,
      }),
      makeLineRow({
        tender_line_id: 'tl-cash',
        tender_type: 'cash',
        amount_applied_minor: 1000,
        change_due_minor: 50,
        apply_order: 1,
        applied_at: '2026-10-15T09:59:00.000Z',
      }),
    ];
    expect(appliedTenderBreakdown(lines, SETTLED_AT)).toEqual([
      expect.objectContaining({
        tender_line_id: 'tl-cash',
        change_due_minor: 50,
        applied_at: '2026-10-15T09:59:00.000Z',
      }),
      expect.objectContaining({
        tender_line_id: 'tl-card',
        external_reference: 'REF-123',
        applied_at: SETTLED_AT,
      }),
    ]);
    const [cash, card] = appliedTenderBreakdown(lines, SETTLED_AT);
    expect(cash).not.toHaveProperty('external_reference');
    expect(card).not.toHaveProperty('change_due_minor');
  });
});
