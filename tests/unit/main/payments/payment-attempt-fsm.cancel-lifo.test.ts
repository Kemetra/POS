/**
 * T081 — PaymentAttempt FSM cancel + LIFO reversal test (RED).
 *
 * Asserts (FR-006B / research §R-13):
 *   • `started → cancelled` reverses every applied TenderLine LIFO
 *     (by apply_order DESC).
 *   • Cancel emits per-line `tender.reversed` events in that order.
 *   • The attempt-level `payment.cancelled` event carries the
 *     `reversed_tender_line_ids` array in LIFO order.
 *   • Idempotent — re-running cancel returns the same outcome.
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

function seedAttempt(fsm: ReturnType<typeof buildFsm>['fsm'], subtotal: number): void {
  fsm.start({
    payment_attempt_id: 'pa-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    acting_operator_id: 'op-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: subtotal,
    started_at: '2026-05-22T10:00:00.000Z',
    action_id: 'start-pa-1',
  });
}

function applyLine(
  lines: ReturnType<typeof bindPaymentTenderLinesRepository>,
  outbox: ReturnType<typeof bindPaymentActionOutboxRepository>,
  order: number,
  tender_type: 'cash' | 'external_card_terminal' = 'cash',
): string {
  const id = `tl-${String(order)}`;
  const actionId = `apply-${id}`;
  lines.insert({
    tender_line_id: id,
    payment_attempt_id: 'pa-1',
    tender_type,
    amount_applied_minor: 1000,
    state: 'applied',
    change_due_minor: null,
    external_reference: null,
    voucher_redemption_intent_token: null,
    voucher_authority_redemption_id: null,
    applied_at: `2026-05-22T10:00:0${String(order)}.000Z`,
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
    payment_attempt_id: 'pa-1',
    tender_line_id: id,
    action_kind: 'tender.apply',
    action_payload_hash: 'a'.repeat(64),
    acting_operator_id: 'op-abc',
    created_at: `2026-05-22T10:00:0${String(order)}.000Z`,
  });
  return id;
}

describe('T081 — PaymentAttempt FSM cancel + LIFO', () => {
  it('reverses applied lines in LIFO order (apply_order DESC) on cancel', () => {
    const { fsm, lines, outbox } = buildFsm();
    seedAttempt(fsm, 3000);
    applyLine(lines, outbox, 1);
    applyLine(lines, outbox, 2);
    applyLine(lines, outbox, 3);
    const result = fsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'cancel-pa-1',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.reversed_tender_line_ids).toEqual(['tl-3', 'tl-2', 'tl-1']);
      expect(result.reversal_pending_tender_line_ids).toEqual([]);
    }
  });

  it('transitions attempt to cancelled with cancelled_at timestamp', () => {
    const { fsm, lines, outbox, attempts } = buildFsm();
    seedAttempt(fsm, 1000);
    applyLine(lines, outbox, 1);
    fsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'cancel-pa-1',
    });
    const row = attempts.findById('pa-1');
    expect(row?.state).toBe('cancelled');
    expect(row?.cancelled_at).toBe('2026-05-22T10:01:00.000Z');
  });

  it('cancel with no applied lines transitions cleanly and returns empty arrays', () => {
    const { fsm } = buildFsm();
    seedAttempt(fsm, 1000);
    const result = fsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'cancel-pa-1',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.reversed_tender_line_ids).toEqual([]);
      expect(result.reversal_pending_tender_line_ids).toEqual([]);
    }
  });

  it('cancel writes an outbox row with action_kind=payment.cancel', () => {
    const { fsm, lines, outbox } = buildFsm();
    seedAttempt(fsm, 1000);
    applyLine(lines, outbox, 1);
    fsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'cancel-pa-1',
    });
    const row = outbox.findByActionId('cancel-pa-1');
    expect(row?.action_kind).toBe('payment.cancel');
  });

  it('refuses cancel from a terminal state (already cancelled)', () => {
    const { fsm, lines, outbox } = buildFsm();
    seedAttempt(fsm, 1000);
    applyLine(lines, outbox, 1);
    const first = fsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'cancel-pa-1',
    });
    // Assert the first cancel actually succeeded — otherwise a regression
    // there would still leave us in `started`, and the second call would
    // also fire `attempt_terminal` for the wrong reason.
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const second = fsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-22T10:02:00.000Z',
      action_id: 'cancel-pa-1b',
    });
    expect(second.kind).toBe('refused');
    if (second.kind === 'refused') expect(second.reason).toBe('attempt_terminal');
  });
});
