/**
 * T087 — TenderLine FSM illegal-transition test (RED).
 *
 * Asserts (research §R-11):
 *   • `refused` is terminal — refuse reverse on a refused line with `line_not_applied`.
 *   • `reversed` is terminal — refuse re-reverse with `line_not_applied`.
 *   • `applying` would never enter the bridge (line creation is atomic via
 *     `tender.apply`); attempting to reverse a line that isn't `applied` is
 *     refused with `line_not_applied`.
 *   • Compile-time matrix exhaustive (isLegalTenderLineTransition).
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
import { TENDER_LINE_STATES, type TenderLineState } from '../../../../src/shared/payments/types.js';
import { isLegalTenderLineTransition } from '../../../../src/shared/payments/fsm-types.js';

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

describe('T087 — TenderLine FSM compile-time matrix', () => {
  it('exposes exactly five TenderLineState values', () => {
    expect(TENDER_LINE_STATES).toHaveLength(5);
  });

  it('refused is terminal — no transitions out', () => {
    for (const to of TENDER_LINE_STATES) {
      expect(isLegalTenderLineTransition('refused', to)).toBe(false);
    }
  });

  it('reversed is terminal — no transitions out', () => {
    for (const to of TENDER_LINE_STATES) {
      expect(isLegalTenderLineTransition('reversed', to)).toBe(false);
    }
  });

  it('applying → applied|refused only', () => {
    const allowed: TenderLineState[] = ['applied', 'refused'];
    for (const to of TENDER_LINE_STATES) {
      expect(isLegalTenderLineTransition('applying', to)).toBe(allowed.includes(to));
    }
  });

  it('applied → reversed|reversal_pending only', () => {
    const allowed: TenderLineState[] = ['reversed', 'reversal_pending'];
    for (const to of TENDER_LINE_STATES) {
      expect(isLegalTenderLineTransition('applied', to)).toBe(allowed.includes(to));
    }
  });

  it('reversal_pending → reversed only', () => {
    for (const to of TENDER_LINE_STATES) {
      expect(isLegalTenderLineTransition('reversal_pending', to)).toBe(to === 'reversed');
    }
  });
});

describe('T087 — runtime illegal-transition refusal', () => {
  it('refuses reverse on a refused line', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });

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
      tender_line_id: 'tl-r',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1500,
      state: 'refused',
      change_due_minor: null,
      external_reference: null,
      voucher_redemption_intent_token: null,
      voucher_authority_redemption_id: null,
      applied_at: null,
      refused_at: '2026-05-22T10:00:01.000Z',
      reversed_at: null,
      reversal_pending_since: null,
      refusal_reason: 'non_cash_overpayment_refused',
      attribution_operator_id: 'op-abc',
      apply_order: 1,
      last_action_id: 'apply-tl-r',
    });
    outbox.insert({
      action_id: 'apply-tl-r',
      payment_attempt_id: 'pa-1',
      tender_line_id: 'tl-r',
      action_kind: 'tender.apply',
      action_payload_hash: 'b'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });

    const result = fsm.reverse({
      tender_line_id: 'tl-r',
      payment_attempt_id: 'pa-1',
      reversed_at: '2026-05-22T10:00:30.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'reverse-tl-r',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('line_not_applied');
  });

  it('refuses reverse on a reversed line (no re-reverse)', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });

    attempts.insert({
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
      last_action_id: 'start-pa-2',
    });
    outbox.insert({
      action_id: 'start-pa-2',
      payment_attempt_id: 'pa-2',
      tender_line_id: null,
      action_kind: 'payment.attempt.start',
      action_payload_hash: 'c'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:00.000Z',
    });
    lines.insert({
      tender_line_id: 'tl-x',
      payment_attempt_id: 'pa-2',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      state: 'reversed',
      change_due_minor: null,
      external_reference: null,
      voucher_redemption_intent_token: null,
      voucher_authority_redemption_id: null,
      applied_at: '2026-05-22T10:00:01.000Z',
      refused_at: null,
      reversed_at: '2026-05-22T10:00:02.000Z',
      reversal_pending_since: null,
      refusal_reason: null,
      attribution_operator_id: 'op-abc',
      apply_order: 1,
      last_action_id: 'reverse-tl-x',
    });
    outbox.insert({
      action_id: 'reverse-tl-x',
      payment_attempt_id: 'pa-2',
      tender_line_id: 'tl-x',
      action_kind: 'tender.reverse',
      action_payload_hash: 'd'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:02.000Z',
    });

    const result = fsm.reverse({
      tender_line_id: 'tl-x',
      payment_attempt_id: 'pa-2',
      reversed_at: '2026-05-22T10:00:30.000Z',
      attribution_operator_id: 'op-abc',
      action_id: 'reverse-tl-x-again',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('line_not_applied');
  });
});
