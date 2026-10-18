/**
 * T080 — PaymentAttempt FSM settlement-invariant test (RED).
 *
 * Asserts (data-model §"Invariant 5"):
 *   Σ (line.amount_applied_minor − COALESCE(line.change_due_minor, 0))
 *     where state='applied'  == payment_attempts.envelope_subtotal_minor
 *
 * Behaviour gated by the FSM:
 *   • `started → settled` succeeds iff the sum equals envelope subtotal.
 *   • underpayment → refused with reason `tender_underpaid`.
 *   • over-sum (defensive; should be impossible per per-line refusals) →
 *     refused with reason `internal_error`.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0001_init.sql',
  '0002_secrets.sql',
  '0003_terminal_assignment.sql',
  '0004_audit_events.sql',
  '0005_operator_sessions.sql',
  '0006_cashier_pin_records.sql',
  '0007_shifts.sql',
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0050_carts_park.sql',
  '0012_create_payment_attempts.sql',
  '0013_payment_attempts_partial_unique_started.sql',
  '0014_create_payment_tender_lines.sql',
  '0015_create_payment_action_outbox.sql',
  '0016_payment_action_outbox_append_only_trigger.sql',
  '0017_extend_audit_event_categories.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

function buildFsm() {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  return { handle, attempts, lines, outbox, fsm };
}

function seedAttempt(
  fsm: ReturnType<typeof buildFsm>['fsm'],
  envelope_subtotal_minor: number,
  overrides: { terminal_id?: string; payment_attempt_id?: string } = {},
): string {
  const id = overrides.payment_attempt_id ?? 'pa-1';
  fsm.start({
    payment_attempt_id: id,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: overrides.terminal_id ?? 'terminal-1',
    acting_operator_id: 'op-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor,
    started_at: '2026-05-22T10:00:00.000Z',
    action_id: `start-${id}`,
  });
  return id;
}

function applyLine(
  lines: ReturnType<typeof bindPaymentTenderLinesRepository>,
  outbox: ReturnType<typeof bindPaymentActionOutboxRepository>,
  payment_attempt_id: string,
  order: number,
  amount: number,
  change: number | null,
  tender_type: 'cash' | 'external_card_terminal' = 'cash',
): string {
  const id = `tl-${payment_attempt_id}-${String(order)}`;
  const actionId = `apply-${id}`;
  lines.insert({
    tender_line_id: id,
    payment_attempt_id,
    tender_type,
    amount_applied_minor: amount,
    state: 'applied',
    change_due_minor: change,
    external_reference: null,
    voucher_redemption_intent_token: null,
    voucher_authority_redemption_id: null,
    applied_at: '2026-05-22T10:00:01.000Z',
    refused_at: null,
    reversed_at: null,
    reversal_pending_since: null,
    refusal_reason: null,
    attribution_operator_id: 'op-abc',
    apply_order: order,
    last_action_id: actionId,
  });
  outbox.insert({
    action_id: actionId,
    payment_attempt_id,
    tender_line_id: id,
    action_kind: 'tender.apply',
    action_payload_hash: 'a'.repeat(64),
    acting_operator_id: 'op-abc',
    created_at: '2026-05-22T10:00:01.000Z',
  });
  return id;
}

describe('T080 — PaymentAttempt FSM settlement invariant', () => {
  it('settles when applied-sum equals envelope subtotal (single cash line, exact)', () => {
    const { fsm, lines, outbox } = buildFsm();
    seedAttempt(fsm, 1500);
    applyLine(lines, outbox, 'pa-1', 1, 1500, null);
    const result = fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(result.kind).toBe('ok');
  });

  it('settles when cash overpays and change_due_minor offsets the overpayment', () => {
    const { fsm, lines, outbox } = buildFsm();
    seedAttempt(fsm, 1500);
    // Tendered 2000, change 500 → net 1500 == subtotal.
    applyLine(lines, outbox, 'pa-1', 1, 2000, 500);
    const result = fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(result.kind).toBe('ok');
  });

  it('settles via split-tender — cash + external_card_terminal summing to subtotal', () => {
    const { fsm, lines, outbox } = buildFsm();
    seedAttempt(fsm, 5000);
    applyLine(lines, outbox, 'pa-1', 1, 2000, null, 'cash');
    applyLine(lines, outbox, 'pa-1', 2, 3000, null, 'external_card_terminal');
    const result = fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(result.kind).toBe('ok');
  });

  it('refuses confirm with tender_underpaid when applied-sum is short', () => {
    const { fsm, lines, outbox } = buildFsm();
    seedAttempt(fsm, 1500);
    applyLine(lines, outbox, 'pa-1', 1, 1000, null);
    const result = fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('tender_underpaid');
  });

  it('refuses confirm with tender_underpaid when no lines applied yet', () => {
    const { fsm } = buildFsm();
    seedAttempt(fsm, 1500);
    const result = fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('tender_underpaid');
  });

  it('writes settled_at + outbox row when settlement succeeds', () => {
    const { fsm, lines, outbox, attempts } = buildFsm();
    seedAttempt(fsm, 1500);
    applyLine(lines, outbox, 'pa-1', 1, 1500, null);
    fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-pa-1',
    });
    const row = attempts.findById('pa-1');
    expect(row?.state).toBe('settled');
    expect(row?.settled_at).toBe('2026-05-22T10:00:05.000Z');
    expect(outbox.findByActionId('confirm-pa-1')).toBeDefined();
  });
});
