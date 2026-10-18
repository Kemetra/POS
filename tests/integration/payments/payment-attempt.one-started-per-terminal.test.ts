/**
 * T084 — Partial unique index integration test (RED).
 *
 * Asserts the migration 0013 partial unique index
 * `payment_attempts_one_started_per_terminal ON payment_attempts (terminal_id) WHERE state='started'`
 * is enforced through the FSM's `start` path (research §R-6):
 *   • Two concurrent `payments.start` calls on the same terminal_id
 *     produce exactly one success and one refusal with reason
 *     `attempt_already_started_on_terminal`.
 *   • Index is partial — a settled (or otherwise terminal) attempt does
 *     NOT prevent a new attempt on the same terminal.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindPaymentAttemptsRepository } from '../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from '../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';
import { createPaymentAttemptFsm } from '../../../src/main/payments/fsm/payment-attempt-fsm.js';

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

function startInput(id: string, terminal_id = 'terminal-1', action_suffix = id) {
  return {
    payment_attempt_id: id,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    terminal_id,
    acting_operator_id: 'op-abc',
    operator_session_id: 'sess-1',
    envelope_handoff_action_id: `handoff-${id}`,
    envelope_cart_id: `cart-${id}`,
    envelope_subtotal_minor: 1500,
    started_at: '2026-05-22T10:00:00.000Z',
    action_id: `start-${action_suffix}`,
  };
}

describe('T084 — partial unique index: one started per terminal', () => {
  it('refuses a second start on the same terminal with attempt_already_started_on_terminal', () => {
    const { fsm } = buildFsm();
    const first = fsm.start(startInput('pa-1'));
    expect(first.kind).toBe('ok');

    const second = fsm.start(startInput('pa-2'));
    expect(second.kind).toBe('refused');
    if (second.kind === 'refused') {
      expect(second.reason).toBe('attempt_already_started_on_terminal');
    }
  });

  it('allows a second start on a different terminal', () => {
    const { fsm } = buildFsm();
    expect(fsm.start(startInput('pa-1', 'terminal-A')).kind).toBe('ok');
    expect(fsm.start(startInput('pa-2', 'terminal-B')).kind).toBe('ok');
  });

  it('allows a new start on the same terminal once the prior attempt is settled', () => {
    const { fsm, lines, outbox } = buildFsm();
    fsm.start(startInput('pa-1'));
    lines.insert({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      state: 'applied',
      change_due_minor: null,
      external_reference: null,
      voucher_redemption_intent_token: null,
      voucher_authority_redemption_id: null,
      applied_at: '2026-05-22T10:00:01.000Z',
      refused_at: null,
      reversed_at: null,
      reversal_pending_since: null,
      refusal_reason: null,
      attribution_operator_id: 'op-abc',
      apply_order: 1,
      last_action_id: 'apply-tl-1',
    });
    outbox.insert({
      action_id: 'apply-tl-1',
      payment_attempt_id: 'pa-1',
      tender_line_id: 'tl-1',
      action_kind: 'tender.apply',
      action_payload_hash: 'a'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-pa-1',
    });

    const result = fsm.start(startInput('pa-2'));
    expect(result.kind).toBe('ok');
  });
});
