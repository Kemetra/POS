/**
 * T085 — TenderLine FSM apply test (RED).
 *
 * Asserts (per-tender-type per data-model §"PaymentTenderLine"):
 *   • Cash apply: writes `applied` state; cash may overpay, in which case
 *     `change_due_minor = amount_applied_minor − remaining_balance_at_apply_time`.
 *   • external_card_terminal apply: exact-amount-only; refuses overpayment
 *     with `non_cash_overpayment_refused`.
 *   • internal_voucher: returns `tender_not_yet_supported` in Slice 3.
 *   • Apply on a terminal attempt is refused with `attempt_terminal`.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import {
  hashActionPayload,
  tenderApplyActionPayload,
} from '../../../../src/main/payments/action-payload.js';
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

function seedStartedAttempt(
  attempts: ReturnType<typeof bindPaymentAttemptsRepository>,
  outbox: ReturnType<typeof bindPaymentActionOutboxRepository>,
  subtotal: number,
): void {
  attempts.insert({
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
}

describe('T085 — TenderLine FSM apply (cash)', () => {
  it('cash exact-amount → applied; change_due_minor is null', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.change_due_minor).toBeUndefined();
    }
    const all = lines.findByAttempt('pa-1');
    expect(all[0]?.change_due_minor).toBeNull();
  });

  it('cash overpay → applied with positive change_due_minor', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 2000,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.change_due_minor).toBe(500);
    expect(lines.findByAttempt('pa-1')[0]?.change_due_minor).toBe(500);
  });

  it('cash exceeding minor units throws (defense in depth)', () => {
    const { fsm, attempts, outbox } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: -1,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('invalid_input');
  });
});

describe('T085 — TenderLine FSM apply (external_card_terminal)', () => {
  it('refuses overpayment with non_cash_overpayment_refused', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 2000,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('non_cash_overpayment_refused');
    expect(lines.findByAttempt('pa-1')[0]?.state).toBe('refused');
  });

  it('accepts exact-balance external_card_terminal line', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1500,
      external_reference: 'AB12XY',
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('ok');
    const row = lines.findByAttempt('pa-1')[0];
    expect(row?.tender_type).toBe('external_card_terminal');
    expect(row?.external_reference).toBe('AB12XY');
    expect(row?.change_due_minor).toBeNull();
  });

  it('refuses invalid external_reference format with invalid_input', () => {
    const { fsm, attempts, outbox } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1500,
      external_reference: 'abc-123', // lowercase + hyphen → fails regex.
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('invalid_input');
  });
});

describe('T085 — TenderLine FSM apply (internal_voucher Wave 4)', () => {
  it('voucher apply WITHOUT voucher_outcome refuses internal_error (defence-in-depth)', () => {
    // Wave 4: the bridge handler always threads a `voucher_outcome` from
    // V-A `vouchers.validate` before driving the FSM (HTTP cannot live in
    // `db.transaction()`). A direct FSM call without it is a contract
    // violation by the caller — refuse cleanly.
    const { fsm, attempts, outbox } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'V-CODE',
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('internal_error');
  });

  it('voucher apply WITH validated voucher_outcome persists an applied line with intent token', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'V-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-X',
        applied_amount_minor: 1500,
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('ok');
    const row = lines.findByLineId('tl-1');
    expect(row?.state).toBe('applied');
    expect(row?.voucher_redemption_intent_token).toBe('token-X');
  });

  it('voucher apply with validated outcome but amount > remaining refuses non_cash_overpayment_refused', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 5000,
      voucher_code: 'V-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-Y',
        applied_amount_minor: 5000,
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('non_cash_overpayment_refused');
    const row = lines.findByLineId('tl-1');
    expect(row?.state).toBe('refused');
    expect(row?.refusal_reason).toBe('non_cash_overpayment_refused');
  });

  it('voucher apply WITH refused voucher_outcome persists a refused line', () => {
    const { fsm, attempts, lines, outbox } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'V-CODE',
      voucher_outcome: { kind: 'refused', reason: 'voucher_expired' },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('voucher_expired');
    const row = lines.findByLineId('tl-1');
    expect(row?.state).toBe('refused');
    expect(row?.refusal_reason).toBe('voucher_expired');
    expect(row?.voucher_redemption_intent_token).toBeNull();
  });
});

describe('RT-304 — voucher outbox hash covers the REQUESTED amount, not the authority-capped one', () => {
  it('applied voucher branch: outbox hash is the hash of the requested amount while the line persists the capped one', () => {
    // V-A authority caps the voucher value at 800 although the caller
    // requested 1000. The persisted line row carries 800, but a same-key
    // retry carries the request (1000), so the outbox `action_payload_hash`
    // MUST be the hash of the 1000 — hashing the persisted 800 would make
    // every retry of a capped voucher refuse with
    // `idempotency_payload_mismatch`. (Supersedes CR-1, which hashed the
    // persisted amount.)
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1000, // caller estimate
      voucher_code: 'V-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-X',
        applied_amount_minor: 800, // V-A-capped value
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    const persistedLine = lines.findByLineId('tl-1');
    expect(persistedLine?.amount_applied_minor).toBe(800);
    const outboxRow = outbox.findByActionId('apply-tl-1');
    expect(outboxRow).toBeDefined();
    const hashFor = (amount_applied_minor: number): string =>
      hashActionPayload(
        'tender.apply',
        tenderApplyActionPayload({
          payment_attempt_id: 'pa-1',
          tender_type: 'internal_voucher',
          amount_applied_minor,
        }),
      );
    // The REQUESTED amount is what is hashed …
    expect(outboxRow?.action_payload_hash).toBe(hashFor(1000));
    // … and NOT the authority-capped amount the line persists.
    expect(outboxRow?.action_payload_hash).not.toBe(hashFor(800));
  });

  it('voucher code never reaches the hash: the stored hash equals the hash of the payload without it', () => {
    const { fsm, attempts, outbox } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1000,
      voucher_code: 'V-SECRET-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-SECRET',
        applied_amount_minor: 1000,
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(outbox.findByActionId('apply-tl-1')?.action_payload_hash).toBe(
      hashActionPayload('tender.apply', {
        payment_attempt_id: 'pa-1',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
      }),
    );
  });

  it('overpayment-refused voucher branch: outbox hash still covers the requested amount', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500, // caller estimate
      voucher_code: 'V-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-X',
        applied_amount_minor: 5000, // > remaining → overpayment-refused
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    const persistedLine = lines.findByLineId('tl-1');
    expect(persistedLine?.amount_applied_minor).toBe(5000);
    expect(persistedLine?.refusal_reason).toBe('non_cash_overpayment_refused');
    const outboxRow = outbox.findByActionId('apply-tl-1');
    const expectedHash = hashActionPayload(
      'tender.apply',
      tenderApplyActionPayload({
        payment_attempt_id: 'pa-1',
        tender_type: 'internal_voucher',
        amount_applied_minor: 1500, // the request, not the authority's 5000
      }),
    );
    expect(outboxRow?.action_payload_hash).toBe(expectedHash);
  });
});

describe('CR-2 — safe-integer guard on authority-returned voucher amount', () => {
  it('refuses internal_error when outcome.applied_amount_minor is a non-integer (1.5)', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'V-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-X',
        // Malformed authority payload — non-integer.
        applied_amount_minor: 1.5,
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('internal_error');
    const row = lines.findByLineId('tl-1');
    expect(row?.state).toBe('refused');
    expect(row?.refusal_reason).toBe('internal_error');
  });

  it('refuses internal_error when outcome.applied_amount_minor is negative (-100)', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'V-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-X',
        applied_amount_minor: -100,
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('internal_error');
    expect(lines.findByLineId('tl-1')?.refusal_reason).toBe('internal_error');
  });

  it('refuses internal_error when outcome.applied_amount_minor exceeds MAX_SAFE_INTEGER', () => {
    const { fsm, attempts, outbox, lines } = buildFsm();
    seedStartedAttempt(attempts, outbox, 1500);
    const result = fsm.apply({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'V-CODE',
      voucher_outcome: {
        kind: 'validated',
        redemption_intent_token: 'token-X',
        applied_amount_minor: Number.MAX_SAFE_INTEGER + 1,
      },
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:00:01.000Z',
      action_id: 'apply-tl-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('internal_error');
    expect(lines.findByLineId('tl-1')?.refusal_reason).toBe('internal_error');
  });
});

describe('T085 — TenderLine FSM apply (attempt-state gating)', () => {
  it('refuses apply when the attempt is settled (terminal state)', () => {
    const { fsm, attempts, outbox } = buildFsm();
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
      action_payload_hash: 'b'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:00.000Z',
    });
    attempts.updateState({
      payment_attempt_id: 'pa-2',
      state: 'settled',
      timestamp: '2026-05-22T10:01:00.000Z',
      last_action_id: 'start-pa-2',
    });
    const result = fsm.apply({
      tender_line_id: 'tl-zz',
      payment_attempt_id: 'pa-2',
      tender_type: 'cash',
      amount_applied_minor: 100,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-22T10:02:00.000Z',
      action_id: 'apply-tl-zz',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });
});
