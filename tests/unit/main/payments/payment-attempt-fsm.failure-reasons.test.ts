/**
 * T082 — PaymentAttempt FSM failure-reason test (RED).
 *
 * Asserts `started → failed` is accepted for every Slice-3-applicable
 * FR-006 closed reason (13 of 14; `voucher_already_redeemed` is reachable
 * only through the Slice-4 `vouchers.redeem` path but the FSM itself
 * still accepts it as a stored reason). Force-fail is Slice 4 — not
 * exercised here.
 *
 * Per-reason persistence: the row's `failure_reason` matches the input
 * and `failed_at` is written. Outbox row is `payment.fail`.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import type { FailureReason } from '../../../../src/shared/payments/types.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATION_NAMES = [
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
];
const MIGRATIONS = MIGRATION_NAMES.map((f) =>
  readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'),
);

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
  return {
    attempts,
    lines,
    outbox,
    fsm: createPaymentAttemptFsm({ db: handle, attempts, lines, outbox }),
  };
}

const SLICE_3_REASONS: FailureReason[] = [
  'cart_lost',
  'operator_session_terminated',
  'dependency_unavailable',
  'internal_error',
  'stale_handoff',
  'tender_underpaid',
  'non_cash_overpayment_refused',
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
  'split_tender_rollback',
];

describe('T082 — PaymentAttempt FSM failure reasons', () => {
  it.each(SLICE_3_REASONS)('accepts started → failed with reason %s', (reason) => {
    const { fsm, attempts, outbox } = buildFsm();
    fsm.start({
      payment_attempt_id: 'pa-1',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-1',
      envelope_cart_id: 'cart-1',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-22T10:00:00.000Z',
      action_id: 'start-pa-1',
    });
    const result = fsm.fail({
      payment_attempt_id: 'pa-1',
      failed_at: '2026-05-22T10:00:30.000Z',
      failure_reason: reason,
      action_id: `fail-pa-1-${reason}`,
    });
    expect(result.kind).toBe('ok');
    const row = attempts.findById('pa-1');
    expect(row?.state).toBe('failed');
    expect(row?.failure_reason).toBe(reason);
    expect(row?.failed_at).toBe('2026-05-22T10:00:30.000Z');
    expect(outbox.findByActionId(`fail-pa-1-${reason}`)?.action_kind).toBe('payment.fail');
  });

  it('writes failed_at + outbox row in one transaction', () => {
    const { fsm, attempts, outbox } = buildFsm();
    fsm.start({
      payment_attempt_id: 'pa-2',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-2',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-2',
      envelope_cart_id: 'cart-2',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-22T10:00:00.000Z',
      action_id: 'start-pa-2',
    });
    fsm.fail({
      payment_attempt_id: 'pa-2',
      failed_at: '2026-05-22T10:00:30.000Z',
      failure_reason: 'cart_lost',
      action_id: 'fail-pa-2',
    });
    expect(attempts.findById('pa-2')?.failure_reason).toBe('cart_lost');
    expect(outbox.findByActionId('fail-pa-2')).toBeDefined();
  });
});
