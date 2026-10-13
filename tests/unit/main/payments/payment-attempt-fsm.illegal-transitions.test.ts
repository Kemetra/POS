/**
 * T083 — PaymentAttempt FSM illegal-transition test (RED).
 *
 * Asserts the FSM refuses every illegal transition pair from the
 * PaymentAttempt state matrix (data-model §"Invariant 1"). Refusal
 * carries reason `attempt_terminal`.
 *
 * Compile-time enforcement: `isLegalPaymentAttemptTransition` is tested
 * against an exhaustive cross-product for completeness.
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
import {
  PAYMENT_ATTEMPT_STATES,
  type PaymentAttemptState,
} from '../../../../src/shared/payments/types.js';
import { isLegalPaymentAttemptTransition } from '../../../../src/shared/payments/fsm-types.js';

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

describe('T083 — compile-time / runtime FSM matrix', () => {
  it('exposes exactly five PaymentAttemptState values', () => {
    expect(PAYMENT_ATTEMPT_STATES).toHaveLength(5);
  });

  it('isLegalPaymentAttemptTransition refuses self-transitions', () => {
    for (const s of PAYMENT_ATTEMPT_STATES) {
      expect(isLegalPaymentAttemptTransition(s, s)).toBe(false);
    }
  });

  it('isLegalPaymentAttemptTransition refuses every terminal→anywhere edge', () => {
    const terminals: PaymentAttemptState[] = ['settled', 'cancelled', 'failed', 'force_failed'];
    for (const from of terminals) {
      for (const to of PAYMENT_ATTEMPT_STATES) {
        expect(isLegalPaymentAttemptTransition(from, to)).toBe(false);
      }
    }
  });

  it('isLegalPaymentAttemptTransition accepts started → {settled, cancelled, failed, force_failed}', () => {
    expect(isLegalPaymentAttemptTransition('started', 'settled')).toBe(true);
    expect(isLegalPaymentAttemptTransition('started', 'cancelled')).toBe(true);
    expect(isLegalPaymentAttemptTransition('started', 'failed')).toBe(true);
    expect(isLegalPaymentAttemptTransition('started', 'force_failed')).toBe(true);
  });
});

describe('T083 — runtime illegal transition refusal', () => {
  it('refuses confirm on a cancelled attempt (cancelled → settled is illegal)', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });

    const started = fsm.start({
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
    expect(started.kind).toBe('ok');
    if (started.kind !== 'ok') return;
    const cancelled = fsm.cancel({
      payment_attempt_id: 'pa-1',
      cancelled_at: '2026-05-22T10:00:30.000Z',
      action_id: 'cancel-pa-1',
    });
    expect(cancelled.kind).toBe('ok');
    if (cancelled.kind !== 'ok') return;
    const result = fsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });

  it('refuses fail on a settled attempt (settled → failed is illegal)', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });

    const started = fsm.start({
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
    expect(started.kind).toBe('ok');
    if (started.kind !== 'ok') return;
    lines.insert({
      tender_line_id: 'tl-1',
      payment_attempt_id: 'pa-2',
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
      payment_attempt_id: 'pa-2',
      tender_line_id: 'tl-1',
      action_kind: 'tender.apply',
      action_payload_hash: 'a'.repeat(64),
      acting_operator_id: 'op-abc',
      created_at: '2026-05-22T10:00:01.000Z',
    });
    const settled = fsm.confirm({
      payment_attempt_id: 'pa-2',
      settled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'confirm-pa-2',
    });
    expect(settled.kind).toBe('ok');
    if (settled.kind !== 'ok') return;
    const result = fsm.fail({
      payment_attempt_id: 'pa-2',
      failed_at: '2026-05-22T10:02:00.000Z',
      failure_reason: 'internal_error',
      action_id: 'fail-pa-2',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });

  it('refuses confirm on an unknown payment_attempt_id', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
    const result = fsm.confirm({
      payment_attempt_id: 'nope',
      settled_at: '2026-05-22T10:00:00.000Z',
      action_id: 'confirm-nope',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });

  it('refuses cancel on an unknown payment_attempt_id', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
    const result = fsm.cancel({
      payment_attempt_id: 'nope',
      cancelled_at: '2026-05-22T10:00:00.000Z',
      action_id: 'cancel-nope',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });

  it('refuses fail on an unknown payment_attempt_id', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
    const result = fsm.fail({
      payment_attempt_id: 'nope',
      failed_at: '2026-05-22T10:00:00.000Z',
      failure_reason: 'internal_error',
      action_id: 'fail-nope',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });

  it('refuses cancel on an already-cancelled attempt (cancelled → cancelled is illegal)', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });

    const started = fsm.start({
      payment_attempt_id: 'pa-3',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-3',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-3',
      envelope_cart_id: 'cart-3',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-22T10:00:00.000Z',
      action_id: 'start-pa-3',
    });
    expect(started.kind).toBe('ok');
    if (started.kind !== 'ok') return;
    const cancelled = fsm.cancel({
      payment_attempt_id: 'pa-3',
      cancelled_at: '2026-05-22T10:00:30.000Z',
      action_id: 'cancel-pa-3',
    });
    expect(cancelled.kind).toBe('ok');
    if (cancelled.kind !== 'ok') return;
    const result = fsm.cancel({
      payment_attempt_id: 'pa-3',
      cancelled_at: '2026-05-22T10:01:00.000Z',
      action_id: 'cancel-pa-3-again',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });

  it('refuses fail on an already-failed attempt (failed → failed is illegal)', () => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });

    const started = fsm.start({
      payment_attempt_id: 'pa-4',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-4',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-4',
      envelope_cart_id: 'cart-4',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-22T10:00:00.000Z',
      action_id: 'start-pa-4',
    });
    expect(started.kind).toBe('ok');
    if (started.kind !== 'ok') return;
    const failed = fsm.fail({
      payment_attempt_id: 'pa-4',
      failed_at: '2026-05-22T10:00:30.000Z',
      failure_reason: 'internal_error',
      action_id: 'fail-pa-4',
    });
    expect(failed.kind).toBe('ok');
    if (failed.kind !== 'ok') return;
    const result = fsm.fail({
      payment_attempt_id: 'pa-4',
      failed_at: '2026-05-22T10:01:00.000Z',
      failure_reason: 'cart_lost',
      action_id: 'fail-pa-4-again',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('attempt_terminal');
  });
});

describe('T083 — defence-in-depth: impossible-state guards', () => {
  it('refuses confirm with internal_error if settlementSum exceeds the envelope (unreachable but guarded)', () => {
    // Per-line refusals make over-payment unreachable in Slice 3. The FSM's
    // confirm() still refuses defensively per Constitution §IV ("refuse rather
    // than ship a phantom settlement"). White-box: stub lines.settlementSumMinor
    // to return a value > envelope_subtotal_minor.
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const realLines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);

    attempts.insert({
      payment_attempt_id: 'pa-over',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-over',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-over',
      envelope_cart_id: 'cart-over',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-22T10:00:00.000Z',
      last_action_id: 'start-over',
    });

    const overpaidLines: typeof realLines = {
      ...realLines,
      settlementSumMinor: () => 1600, // > envelope (1500)
    };

    const fsm = createPaymentAttemptFsm({
      db: handle,
      attempts,
      lines: overpaidLines,
      outbox,
    });
    const result = fsm.confirm({
      payment_attempt_id: 'pa-over',
      settled_at: '2026-05-22T10:00:05.000Z',
      action_id: 'confirm-over',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('internal_error');
  });
});

describe('T083 — start path: money invariant on envelope_subtotal_minor', () => {
  it.each([
    ['float', 1500.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['negative', -1],
  ])('refuses start with invalid_input on a %s envelope_subtotal_minor', (_label, badValue) => {
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });

    const result = fsm.start({
      payment_attempt_id: 'pa-bad-money',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-bad-money',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-bad-money',
      envelope_cart_id: 'cart-bad-money',
      envelope_subtotal_minor: badValue,
      started_at: '2026-05-22T10:00:00.000Z',
      action_id: 'start-bad-money',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.reason).toBe('invalid_input');
    // No row should have been inserted.
    expect(attempts.findById('pa-bad-money')).toBeUndefined();
  });

  it('accepts envelope_subtotal_minor === 0 (zero-subtotal is a valid degenerate case)', () => {
    // The money guard rejects negative/non-integer but MUST allow 0 — the
    // settlement invariant Σ amount = envelope is still well-defined.
    const handle = makeSqlJsHandle(db);
    const attempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);
    const fsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
    const result = fsm.start({
      payment_attempt_id: 'pa-zero',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-zero',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-zero',
      envelope_cart_id: 'cart-zero',
      envelope_subtotal_minor: 0,
      started_at: '2026-05-22T10:00:00.000Z',
      action_id: 'start-zero',
    });
    expect(result.kind).toBe('ok');
  });
});

describe('T083 — start path: unique-violation race fallback', () => {
  it('returns attempt_already_started_on_terminal when the partial unique index races past the pre-check', () => {
    // The pre-check (findStartedByTerminal) is the first guard; the partial
    // unique index is the second. If two concurrent callers slip past the
    // pre-check, the SQL UNIQUE error must be translated to the closed
    // refusal reason rather than surfacing as a raw exception. We simulate
    // by stubbing the attempts repository so the pre-check returns undefined
    // but `insert` throws a UNIQUE error — covers `isUniqueViolation()`.
    const handle = makeSqlJsHandle(db);
    const realAttempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);

    const racingAttempts: typeof realAttempts = {
      ...realAttempts,
      findStartedByTerminal: () => undefined,
      insert: () => {
        const e = new Error('UNIQUE constraint failed: payment_attempts.terminal_id');
        throw e;
      },
    };

    const fsm = createPaymentAttemptFsm({
      db: handle,
      attempts: racingAttempts,
      lines,
      outbox,
    });
    const result = fsm.start({
      payment_attempt_id: 'pa-race',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-race',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-race',
      envelope_cart_id: 'cart-race',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-22T10:00:00.000Z',
      action_id: 'start-race',
    });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toBe('attempt_already_started_on_terminal');
    }
  });

  it('re-throws non-unique errors (defensive: only translate UNIQUE violations)', () => {
    const handle = makeSqlJsHandle(db);
    const realAttempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);

    const erroringAttempts: typeof realAttempts = {
      ...realAttempts,
      findStartedByTerminal: () => undefined,
      insert: () => {
        throw new Error('disk I/O error');
      },
    };

    const fsm = createPaymentAttemptFsm({
      db: handle,
      attempts: erroringAttempts,
      lines,
      outbox,
    });
    expect(() =>
      fsm.start({
        payment_attempt_id: 'pa-io',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: 'terminal-io',
        acting_operator_id: 'op-abc',
        operator_session_id: 'sess-1',
        envelope_handoff_action_id: 'handoff-io',
        envelope_cart_id: 'cart-io',
        envelope_subtotal_minor: 1500,
        started_at: '2026-05-22T10:00:00.000Z',
        action_id: 'start-io',
      }),
    ).toThrow(/disk I\/O error/);
  });

  it('isUniqueViolation defensively rejects non-Error throwables (null, primitive, no message)', () => {
    // White-box exercise: simulate insert throwing a non-Error to drive the
    // `typeof err !== 'object' || err === null` and `msg ?? ''` branches.
    const handle = makeSqlJsHandle(db);
    const realAttempts = bindPaymentAttemptsRepository(handle);
    const lines = bindPaymentTenderLinesRepository(handle);
    const outbox = bindPaymentActionOutboxRepository(handle);

    // Case 1: thrown primitive (not an object).
    const primitiveAttempts: typeof realAttempts = {
      ...realAttempts,
      findStartedByTerminal: () => undefined,
      insert: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'not an object';
      },
    };
    const fsm1 = createPaymentAttemptFsm({
      db: handle,
      attempts: primitiveAttempts,
      lines,
      outbox,
    });
    expect(() =>
      fsm1.start({
        payment_attempt_id: 'pa-prim',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: 'terminal-prim',
        acting_operator_id: 'op-abc',
        operator_session_id: 'sess-1',
        envelope_handoff_action_id: 'handoff-prim',
        envelope_cart_id: 'cart-prim',
        envelope_subtotal_minor: 1500,
        started_at: '2026-05-22T10:00:00.000Z',
        action_id: 'start-prim',
      }),
    ).toThrow();

    // Case 2: object without a message field.
    const messagelessAttempts: typeof realAttempts = {
      ...realAttempts,
      findStartedByTerminal: () => undefined,
      insert: () => {
        throw {} as unknown as Error;
      },
    };
    const fsm2 = createPaymentAttemptFsm({
      db: handle,
      attempts: messagelessAttempts,
      lines,
      outbox,
    });
    expect(() =>
      fsm2.start({
        payment_attempt_id: 'pa-noMsg',
        tenant_id: 'tenant-1',
        branch_id: 'branch-1',
        terminal_id: 'terminal-noMsg',
        acting_operator_id: 'op-abc',
        operator_session_id: 'sess-1',
        envelope_handoff_action_id: 'handoff-noMsg',
        envelope_cart_id: 'cart-noMsg',
        envelope_subtotal_minor: 1500,
        started_at: '2026-05-22T10:00:00.000Z',
        action_id: 'start-noMsg',
      }),
    ).toThrow();
  });
});
