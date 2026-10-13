/**
 * T086 — TenderLine FSM reverse test (RED).
 *
 * Asserts (contract §"tender.reverse"):
 *   • `applied → reversed` for cash and external_card_terminal.
 *   • TenderLine row carries `reversed_at`; `tender.reversed` outbox row written.
 *   • Voucher reverse is Slice 4 — Slice 3 returns `tender_not_yet_supported`.
 *   • `manual_void_required` flag exposed for external_card_terminal reversals
 *     (consumed by the audit emitter in T132).
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
  return {
    attempts,
    lines,
    outbox,
    fsm: createTenderLineFsm({ db: handle, attempts, lines, outbox }),
  };
}

function seed(
  attempts: ReturnType<typeof bindPaymentAttemptsRepository>,
  lines: ReturnType<typeof bindPaymentTenderLinesRepository>,
  outbox: ReturnType<typeof bindPaymentActionOutboxRepository>,
  tender_type: 'cash' | 'external_card_terminal' = 'cash',
  external_reference: string | null = null,
): string {
  attempts.insert({
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
  const id = 'tl-1';
  lines.insert({
    tender_line_id: id,
    payment_attempt_id: 'pa-1',
    tender_type,
    amount_applied_minor: 1500,
    state: 'applied',
    change_due_minor: null,
    external_reference,
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
    tender_line_id: id,
    action_kind: 'tender.apply',
    action_payload_hash: 'b'.repeat(64),
    acting_operator_id: 'op-abc',
    created_at: '2026-05-22T10:00:01.000Z',
  });
  return id;
}

describe('T086 — TenderLine FSM reverse', () => {
  it('reverses a cash applied line and writes reversed_at', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seed(attempts, lines, outbox, 'cash');
    const result = fsm.reverse({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-22T10:00:30.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'reverse-tl-1',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state).toBe('reversed');
      expect(result.manual_void_required).toBe(false);
    }
    expect(lines.findByAttempt('pa-1')[0]?.state).toBe('reversed');
    expect(lines.findByAttempt('pa-1')[0]?.reversed_at).toBe('2026-05-22T10:00:30.000Z');
  });

  it('reverses an external_card_terminal applied line; exposes manual_void_required flag', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seed(attempts, lines, outbox, 'external_card_terminal', 'AB12XY');
    const result = fsm.reverse({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-22T10:00:30.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'reverse-tl-1',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state).toBe('reversed');
      expect(result.manual_void_required).toBe(true);
    }
  });

  it('Wave 4 — reverses an applied voucher line synchronously (V-A call lives in the handler)', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    // Seed voucher line manually (skipping FSM apply since voucher Slice 4).
    attempts.insert({
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
    lines.insert({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      state: 'applied',
      change_due_minor: null,
      external_reference: null,
      voucher_redemption_intent_token: 'tok-x',
      voucher_authority_redemption_id: null,
      applied_at: '2026-05-22T10:00:01.000Z',
      refused_at: null,
      reversed_at: null,
      reversal_pending_since: null,
      refusal_reason: null,
      attribution_operator_id: 'op-abc',
      apply_order: 1,
      last_action_id: 'apply-tl-v',
    });
    outbox.insert({
      action_id: 'apply-tl-v',
      payment_attempt_id: 'pa-1',
      tender_line_id: 'tl-v',
      action_kind: 'tender.apply',
      action_payload_hash: 'c'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    const result = fsm.reverse({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-22T10:00:30.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'reverse-tl-v',
    });
    // Wave 4: FSM allows the transition; the bridge handler is the seam
    // that calls V-A first and gates `markReversalPending` vs
    // `confirmReversed` based on the V-A outcome. The bare FSM-level
    // `reverse()` call here exercises the now-permitted transition.
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state).toBe('reversed');
      expect(result.tender_type).toBe('internal_voucher');
    }
  });
});

describe('T264 — TenderLine FSM markReversalPending + confirmReversed (Wave 4)', () => {
  function seedApplied(
    attempts: ReturnType<typeof bindPaymentAttemptsRepository>,
    lines: ReturnType<typeof bindPaymentTenderLinesRepository>,
    outbox: ReturnType<typeof bindPaymentActionOutboxRepository>,
  ) {
    attempts.insert({
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
    lines.insert({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      state: 'applied',
      change_due_minor: null,
      external_reference: null,
      voucher_redemption_intent_token: 'tok-x',
      voucher_authority_redemption_id: 'red-y',
      applied_at: '2026-05-22T10:00:01.000Z',
      refused_at: null,
      reversed_at: null,
      reversal_pending_since: null,
      refusal_reason: null,
      attribution_operator_id: 'op-abc',
      apply_order: 1,
      last_action_id: 'apply-tl-v',
    });
    outbox.insert({
      action_id: 'apply-tl-v',
      payment_attempt_id: 'pa-1',
      tender_line_id: 'tl-v',
      action_kind: 'tender.apply',
      action_payload_hash: 'c'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
  }

  it('markReversalPending transitions an applied voucher line to reversal_pending', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seedApplied(attempts, lines, outbox);
    const result = fsm.markReversalPending({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversal_pending_since: '2026-05-25T10:00:10.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'pend-tl-v',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.reversal_pending_since).toBe('2026-05-25T10:00:10.000Z');
      expect(result.tender_type).toBe('internal_voucher');
    }
    const row = lines.findByLineId('tl-v');
    expect(row?.state).toBe('reversal_pending');
    expect(row?.reversal_pending_since).toBe('2026-05-25T10:00:10.000Z');
  });

  it('markReversalPending refuses line_not_applied when the line is unknown', () => {
    const { fsm } = buildFsm();
    const result = fsm.markReversalPending({
      tender_line_id: 'tl-DOES-NOT-EXIST',
      payment_attempt_id: 'pa-1',
      reversal_pending_since: '2026-05-25T10:00:10.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'pend-tl-v',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('line_not_applied');
  });

  it('markReversalPending refuses line_not_applied when the line is already reversed', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seedApplied(attempts, lines, outbox);
    fsm.reverse({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-25T09:50:00.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'reverse-tl-v',
    });
    const result = fsm.markReversalPending({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversal_pending_since: '2026-05-25T10:00:10.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'pend-tl-v',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('line_not_applied');
  });

  it('confirmReversed transitions a reversal_pending line to reversed', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seedApplied(attempts, lines, outbox);
    fsm.markReversalPending({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversal_pending_since: '2026-05-25T09:50:00.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'pend-tl-v',
    });
    const result = fsm.confirmReversed({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-25T10:05:00.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'confirm-rev-tl-v',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.reversed_at).toBe('2026-05-25T10:05:00.000Z');
      expect(result.tender_type).toBe('internal_voucher');
    }
    const row = lines.findByLineId('tl-v');
    expect(row?.state).toBe('reversed');
    expect(row?.reversed_at).toBe('2026-05-25T10:05:00.000Z');
    expect(row?.reversal_pending_since).toBeNull();
  });

  it('confirmReversed refuses line_not_applied when the line is unknown', () => {
    const { fsm } = buildFsm();
    const result = fsm.confirmReversed({
      tender_line_id: 'tl-DOES-NOT-EXIST',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-25T10:05:00.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'confirm-rev-tl-v',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('line_not_applied');
  });

  it('confirmReversed refuses line_not_applied when the line is in a terminal state already', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seedApplied(attempts, lines, outbox);
    fsm.reverse({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-25T09:50:00.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'reverse-tl-v',
    });
    const result = fsm.confirmReversed({
      tender_line_id: 'tl-v',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-25T10:05:00.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'confirm-rev-tl-v',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('line_not_applied');
  });
});
