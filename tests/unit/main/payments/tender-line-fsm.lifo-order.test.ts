/**
 * T088 — TenderLine FSM apply-order + LIFO test (RED).
 *
 * Asserts:
 *   • `apply_order` is monotonic per attempt — first applied line gets order 1,
 *     second gets 2, etc.
 *   • Refused lines still claim an apply_order (they participate in history
 *     but not in the settlement-sum; data-model §"PaymentTenderLine" Invariant 7).
 *   • LIFO reversal helper iterates applied lines by apply_order DESC.
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
import { createTenderLineFsm } from '../../../../src/main/payments/fsm/tender-line-fsm.js';

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
  attempts.insert({
    payment_attempt_id: 'pa-1',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    acting_operator_id: 'op-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: 'handoff-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 5000,
    started_at: '2026-05-22T10:00:00.000Z',
    last_action_id: 'start-pa-1',
  });
  outbox.insert({
    action_id: 'start-pa-1',
    payment_attempt_id: 'pa-1',
    tender_line_id: null,
    action_kind: 'payment.attempt.start',
    action_payload_hash: 'a'.repeat(64),
    acting_operator_id: 'op-abc',
    created_at: '2026-05-22T10:00:00.000Z',
  });
  return {
    attempts,
    lines,
    outbox,
    fsm: createTenderLineFsm({ db: handle, attempts, lines, outbox }),
  };
}

describe('T088 — TenderLine FSM apply_order + LIFO', () => {
  it('assigns monotonic apply_order starting at 1', () => {
    const { fsm, lines } = buildFsm();
    fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1000,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    fsm.apply({
      tender_line_id: 'tl-2',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1000,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:02.000Z',
      action_id: 'apply-tl-2',
    });
    const all = lines.findByAttempt('pa-1');
    expect(all.map((l) => [l.tender_line_id, l.apply_order])).toEqual([
      ['tl-1', 1],
      ['tl-2', 2],
    ]);
  });

  it('refused lines still claim a monotonic apply_order', () => {
    const { fsm, lines } = buildFsm();
    fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1000,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    fsm.apply({
      tender_line_id: 'tl-2',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 9999, // refused — overpayment.
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:02.000Z',
      action_id: 'apply-tl-2',
    });
    fsm.apply({
      tender_line_id: 'tl-3',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 4000,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:03.000Z',
      action_id: 'apply-tl-3',
    });
    const orders = lines
      .findByAttempt('pa-1')
      .map((l) => [l.tender_line_id, l.state, l.apply_order]);
    expect(orders).toEqual([
      ['tl-1', 'applied', 1],
      ['tl-2', 'refused', 2],
      ['tl-3', 'applied', 3],
    ]);
  });

  it('reverseAppliedLifo returns applied lines in apply_order DESC', () => {
    const { fsm, lines } = buildFsm();
    for (const i of [1, 2, 3]) {
      const s = String(i);
      fsm.apply({
        tender_line_id: `tl-${s}`,
        payment_attempt_id: 'pa-1',
        tender_type: 'cash',
        amount_applied_minor: 1000,
        attribution_operator_id: 'op-abc',
        applied_at: `2026-05-22T10:00:0${s}.000Z`,
        action_id: `apply-tl-${s}`,
      });
    }
    const lifoIds = fsm.listAppliedLifoIds('pa-1');
    expect(lifoIds).toEqual(['tl-3', 'tl-2', 'tl-1']);
    // Sanity check the underlying SQL order is ASC.
    const allRows = lines.findByAttempt('pa-1').map((l) => l.tender_line_id);
    expect(allRows).toEqual(['tl-1', 'tl-2', 'tl-3']);
  });
});
