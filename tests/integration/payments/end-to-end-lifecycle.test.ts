/**
 * T161 — End-to-end attempt lifecycle integration test.
 *
 * Drives a complete Slice-3 payment attempt through all three SQLite
 * tables (`payment_attempts`, `payment_tender_lines`, `payment_action_outbox`):
 *
 *   1. payments.start  → payment_attempts row in state='started'
 *   2. tender.apply (cash) for 400 minor units → payment_tender_lines row
 *      in state='applied', payment_action_outbox row
 *   3. tender.apply (external_card_terminal) for 600 minor units →
 *      payment_tender_lines row in state='applied', payment_action_outbox row
 *   4. payments.confirm → payment_attempts row in state='settled'
 *      Settlement invariant: Σ(amount − change) = envelope_subtotal_minor.
 *      payment_action_outbox row for the confirm.
 *
 * Asserts:
 *   • All three tables are populated correctly after each step.
 *   • Settlement invariant holds at confirm time (sum equals subtotal exactly).
 *   • Outbox contains exactly 4 rows (start, 2 × apply, confirm).
 *   • Per-line attribution_operator_id matches the apply caller.
 *
 * Uses the sql.js + SqlJsHandle harness shared with the S3a/S3b/S3c
 * integration tests; no native SQLite compile required.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindPaymentAttemptsRepository } from '../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from '../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';
import { createPaymentAttemptFsm } from '../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../src/main/payments/fsm/tender-line-fsm.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
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

// CR-12: explicitly close the SqlJsDatabase after each test so its wasm
// memory is freed deterministically. Without this, every test leaks an
// in-memory SQLite (sql.js does not auto-finalise on GC; the JS object
// holds the wasm handle indefinitely).
afterEach(() => {
  db.close();
});

function buildStack() {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const attemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const lineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  return { handle, attempts, lines, outbox, attemptFsm, lineFsm };
}

describe('T161 — end-to-end attempt lifecycle', () => {
  it('start → apply cash 400 → apply external_card_terminal 600 → confirm → settled', () => {
    const { handle, attempts, lines, attemptFsm, lineFsm } = buildStack();

    // 1. payments.start (subtotal 1000)
    const startResult = attemptFsm.start({
      payment_attempt_id: 'pa-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 1000,
      started_at: '2026-05-23T12:00:00.000Z',
      action_id: 'start-pa-1',
    });
    expect(startResult.kind).toBe('ok');
    const attemptRow = attempts.findById('pa-1');
    expect(attemptRow?.state).toBe('started');
    expect(attemptRow?.envelope_subtotal_minor).toBe(1000);

    // 2. tender.apply cash 400 (partial — split-tender)
    const cashApply = lineFsm.apply({
      tender_line_id: 'tl-cash-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 400,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-23T12:00:01.000Z',
      action_id: 'apply-tl-cash-1',
    });
    expect(cashApply.kind).toBe('ok');
    const cashLines = lines.findByAttempt('pa-1');
    expect(cashLines).toHaveLength(1);
    expect(cashLines[0]?.state).toBe('applied');
    expect(cashLines[0]?.tender_type).toBe('cash');
    expect(cashLines[0]?.amount_applied_minor).toBe(400);
    expect(cashLines[0]?.attribution_operator_id).toBe('op-abc');

    // 3. tender.apply external_card_terminal 600 (exact remaining)
    const cardApply = lineFsm.apply({
      tender_line_id: 'tl-card-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 600,
      external_reference: 'T1A2B3',
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-23T12:00:02.000Z',
      action_id: 'apply-tl-card-1',
    });
    expect(cardApply.kind).toBe('ok');
    const bothLines = lines.findByAttempt('pa-1');
    expect(bothLines).toHaveLength(2);
    const cardLine = bothLines.find((l) => l.tender_line_id === 'tl-card-1');
    expect(cardLine?.state).toBe('applied');
    expect(cardLine?.amount_applied_minor).toBe(600);

    // Settlement invariant precondition: Σ amount = 1000.
    expect(lines.settlementSumMinor('pa-1')).toBe(1000);

    // 4. payments.confirm — settlement invariant satisfied.
    const confirmResult = attemptFsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-23T12:00:03.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(confirmResult.kind).toBe('ok');
    const settled = attempts.findById('pa-1');
    expect(settled?.state).toBe('settled');
    expect(settled?.settled_at).toBe('2026-05-23T12:00:03.000Z');

    // Outbox: 4 rows (start, 2 × apply, confirm). The repo surface exposes
    // findByActionId only, so peek at the raw db for the kinds aggregate.
    const stmt = handle.prepare(
      'SELECT action_kind FROM payment_action_outbox WHERE payment_attempt_id = ? ORDER BY action_kind',
    ) as { all(...params: unknown[]): { action_kind: string }[] };
    const outboxRows = stmt.all('pa-1');
    expect(outboxRows).toHaveLength(4);
    const kinds = outboxRows.map((r) => r.action_kind).sort();
    expect(kinds).toEqual([
      'payment.attempt.start',
      'payment.confirm',
      'tender.apply',
      'tender.apply',
    ]);
  });

  it('refuses confirm when the running sum is below the subtotal (tender_underpaid)', () => {
    const { attemptFsm, lineFsm } = buildStack();
    attemptFsm.start({
      payment_attempt_id: 'pa-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 1000,
      started_at: '2026-05-23T12:00:00.000Z',
      action_id: 'start-pa-1',
    });
    lineFsm.apply({
      tender_line_id: 'tl-cash-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 400,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-23T12:00:01.000Z',
      action_id: 'apply-tl-cash-1',
    });

    const confirmResult = attemptFsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-23T12:00:03.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(confirmResult.kind).toBe('refused');
    if (confirmResult.kind === 'refused') {
      expect(confirmResult.reason).toBe('tender_underpaid');
    }
  });

  it('cancel reverses applied lines LIFO and transitions to cancelled', () => {
    const { attempts, lines, attemptFsm, lineFsm } = buildStack();
    attemptFsm.start({
      payment_attempt_id: 'pa-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 1000,
      started_at: '2026-05-23T12:00:00.000Z',
      action_id: 'start-pa-1',
    });
    lineFsm.apply({
      tender_line_id: 'tl-cash-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 400,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-23T12:00:01.000Z',
      action_id: 'apply-tl-cash-1',
    });
    lineFsm.apply({
      tender_line_id: 'tl-card-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 600,
      external_reference: 'T1A2B3',
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-23T12:00:02.000Z',
      action_id: 'apply-tl-card-1',
    });

    const cancelResult = attemptFsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-23T12:00:04.000Z',
      action_id: 'cancel-pa-1',
    });
    expect(cancelResult.kind).toBe('ok');

    const attempt = attempts.findById('pa-1');
    expect(attempt?.state).toBe('cancelled');

    // Both applied lines should be reversed (cash + external_card_terminal both
    // reverse synchronously in Slice 3 — voucher_intent is the only deferred
    // path and is Slice 4 territory).
    const finalLines = lines.findByAttempt('pa-1');
    for (const line of finalLines) {
      expect(line.state).toBe('reversed');
    }

    // CR-13: assert LIFO order explicitly. The cancel outcome's
    // reversed_tender_line_ids is recorded by the FSM in the order the
    // tender-line FSM reverses lines, which is last-applied-first per FR-006B.
    if (cancelResult.kind === 'ok') {
      expect(cancelResult.reversed_tender_line_ids).toEqual(['tl-card-1', 'tl-cash-1']);
      expect(cancelResult.reversal_pending_tender_line_ids).toEqual([]);
    }
  });
});
