/**
 * T162 — Restart-survival integration test.
 *
 * Per research §R-1 and data-model §"PaymentAttempt" Invariant 7: an
 * in-flight payment attempt + its applied tender lines MUST survive a
 * main-process restart by being rehydrated from the SQLite tables.
 *
 * Simulation:
 *   1. Build the full repo + FSM stack against a fresh SqlJsDatabase.
 *   2. payments.start, then tender.apply (cash, 400 minor of a 1000 subtotal).
 *   3. Export the database to a byte buffer (snapshot of all tables).
 *   4. Discard the FSM, repos, and SqlJsDatabase entirely — modelling
 *      the main-process worker being killed.
 *   5. Open a *new* SqlJsDatabase from the exported bytes — modelling a
 *      cold boot reading the same SQLite file from disk.
 *   6. Re-bind repos + FSM on the new handle.
 *   7. Assert: findById('pa-1') returns state='started' with the same
 *      envelope_subtotal_minor; findByAttempt('pa-1') returns the one
 *      'applied' tender line with the same amount_applied_minor.
 *   8. Drive a second tender.apply (external_card_terminal 600) and
 *      payments.confirm against the rehydrated stack to prove the FSM
 *      can resume the attempt to settlement.
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

function buildStack(db: SqlJsDatabase) {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const attemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const lineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  return { handle, attempts, lines, outbox, attemptFsm, lineFsm };
}

function makeFreshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

let preRestartDb: SqlJsDatabase;
beforeEach(() => {
  preRestartDb = makeFreshDb();
});

describe('T162 — restart-survival integration', () => {
  it('rehydrates a started attempt + one applied line through a simulated restart', () => {
    // 1. Pre-restart: full stack, start + apply one cash line.
    const pre = buildStack(preRestartDb);
    pre.attemptFsm.start({
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
    pre.lineFsm.apply({
      tender_line_id: 'tl-cash-1',
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 400,
      attribution_operator_id: 'op-abc',
      applied_at: '2026-05-23T12:00:01.000Z',
      action_id: 'apply-tl-cash-1',
    });
    // Snapshot the entire database to bytes (modelling a flushed SQLite file).
    const snapshot = preRestartDb.export();

    // 2. Discard everything — the FSM stack, repos, and the underlying
    //    SqlJsDatabase are all garbage. This is the closest analogue to a
    //    main-process worker exit.
    preRestartDb.close();

    // 3. Cold boot: open a fresh SqlJsDatabase from the snapshot. Re-bind
    //    the stack against the new handle. No re-running of migrations —
    //    the schema is already in the snapshot.
    const postRestartDb = new SQL.Database(snapshot);
    postRestartDb.exec('PRAGMA foreign_keys = ON;');
    const post = buildStack(postRestartDb);

    // 4. Rehydrate: assert the attempt + line are intact.
    const attemptRow = post.attempts.findById('pa-1');
    expect(attemptRow).toBeDefined();
    expect(attemptRow?.state).toBe('started');
    expect(attemptRow?.envelope_subtotal_minor).toBe(1000);
    expect(attemptRow?.terminal_id).toBe('terminal-1');

    const linesAfter = post.lines.findByAttempt('pa-1');
    expect(linesAfter).toHaveLength(1);
    expect(linesAfter[0]?.state).toBe('applied');
    expect(linesAfter[0]?.amount_applied_minor).toBe(400);
    expect(linesAfter[0]?.tender_type).toBe('cash');

    // 5. The rehydrated FSM must be able to drive the attempt to settlement.
    const cardApply = post.lineFsm.apply({
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

    const confirmResult = post.attemptFsm.confirm({
      payment_attempt_id: 'pa-1',
      settled_at: '2026-05-23T12:00:03.000Z',
      action_id: 'confirm-pa-1',
    });
    expect(confirmResult.kind).toBe('ok');

    const settled = post.attempts.findById('pa-1');
    expect(settled?.state).toBe('settled');
    postRestartDb.close();
  });

  it('refuses a duplicate start on the same terminal after restart (partial unique index survives)', () => {
    // Pre-restart: start an attempt.
    const pre = buildStack(preRestartDb);
    pre.attemptFsm.start({
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
    const snapshot = preRestartDb.export();
    preRestartDb.close();

    // Restart.
    const postRestartDb = new SQL.Database(snapshot);
    postRestartDb.exec('PRAGMA foreign_keys = ON;');
    const post = buildStack(postRestartDb);

    // A second start on the same terminal must still be refused — the
    // partial unique index lives in the SQLite schema, not in process memory.
    const second = post.attemptFsm.start({
      payment_attempt_id: 'pa-2',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
      acting_operator_id: 'op-abc',
      operator_session_id: 'sess-1',
      envelope_handoff_action_id: 'handoff-2',
      envelope_cart_id: 'cart-2',
      envelope_subtotal_minor: 500,
      started_at: '2026-05-23T12:01:00.000Z',
      action_id: 'start-pa-2',
    });
    expect(second.kind).toBe('refused');
    if (second.kind === 'refused') {
      expect(second.reason).toBe('attempt_already_started_on_terminal');
    }
    postRestartDb.close();
  });
});
