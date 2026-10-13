/**
 * T297 — Force-fail end-to-end integration test (Wave 5d).
 *
 * Drives the manager-force-fail path against a real sql.js SQLite
 * database. Asserts (per FR-021):
 *
 *   1. **State** — a stuck `started` attempt opened by a cashier
 *      transitions to `force_failed` when the manager drives the
 *      FSM's `forceFail`. The attempt row carries:
 *        - `state = 'force_failed'`
 *        - `failure_reason = 'manager_force_failed'`
 *        - `force_fail_attribution_operator_id` = manager id
 *        - `acting_operator_id` UNCHANGED (= original cashier;
 *          immutable since `payments.start`).
 *
 *   2. **Outbox dual attribution** — the `payment.force_fail`
 *      outbox row records the manager as `acting_operator_id`
 *      (the authoriser); the original cashier remains on the
 *      attempt row. Together they form the audit dual-attribution
 *      lineage.
 *
 *   3. **FR-021 last clause** — the bridge response shape (what the
 *      renderer consumes) MUST NOT echo the manager identity. The
 *      manager id stays main-side; cashier-visible UI receives only
 *      a kind/timestamp pair. We assert the response shape directly
 *      (composed by the FSM outcome — `kind: 'ok'` + `force_failed_at`).
 *
 * Boundary discipline: same as voucher-end-to-end.test.ts — FSM
 * direct + real SQL + minimal repo/outbox introspection. No V-A
 * involvement (force-fail is purely local state).
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
  '0018_audit_event_tender_reversal_pending.sql',
  '0019_extend_payment_failure_reason_enum.sql',
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

afterEach(() => {
  db.close();
});

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'terminal-1';
const CASHIER = 'op-cashier-stuck';
const CASHIER_SESSION = 'sess-cashier-stuck';
const MANAGER = 'op-manager-supervisor';

function buildStack() {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const attemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const lineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  return { handle, attempts, lines, outbox, attemptFsm, lineFsm };
}

describe('T297 — force-fail end-to-end integration', () => {
  // Wave 5e closes F-W5D-001 (migration
  // `0019_extend_payment_failure_reason_enum.sql` extends the
  // `payment_attempts.failure_reason` CHECK enum with
  // `'manager_force_failed'`), unblocking the two assertions below.
  // History: Wave 5d originally surfaced the bug and recorded these
  // as `it.todo()`; Wave 5e promotes them to `it()`.

  it('manager force-fails a stuck started attempt: row dual-attribution + outbox', () => {
    const { handle, attempts, attemptFsm } = buildStack();

    // 1. Cashier starts an attempt and it gets stuck in `started`.
    attemptFsm.start({
      payment_attempt_id: 'pa-stuck',
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      acting_operator_id: CASHIER,
      operator_session_id: CASHIER_SESSION,
      envelope_handoff_action_id: 'handoff-stuck',
      envelope_cart_id: 'cart-stuck',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-25T11:00:00.000Z',
      action_id: 'start-pa-stuck',
    });
    const started = attempts.findById('pa-stuck');
    expect(started?.state).toBe('started');
    expect(started?.acting_operator_id).toBe(CASHIER);
    expect(started?.force_fail_attribution_operator_id).toBeNull();

    // 2. Manager force-fails via the FSM.
    const result = attemptFsm.forceFail({
      payment_attempt_id: 'pa-stuck',
      force_failed_at: '2026-05-25T11:45:30.000Z',
      manager_operator_id: MANAGER,
      action_id: 'force-fail-pa-stuck',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.force_failed_at).toBe('2026-05-25T11:45:30.000Z');
    }

    // 3. Row dual attribution:
    //    - state moved to force_failed
    //    - failure_reason = 'manager_force_failed' (Wave 5e CHECK enum)
    //    - force_fail_attribution_operator_id = manager
    //    - acting_operator_id UNCHANGED (= original cashier)
    const row = attempts.findById('pa-stuck');
    expect(row?.state).toBe('force_failed');
    expect(row?.failure_reason).toBe('manager_force_failed');
    expect(row?.force_fail_attribution_operator_id).toBe(MANAGER);
    expect(row?.acting_operator_id).toBe(CASHIER); // immutable since start

    // 4. Outbox: the force_fail row records the MANAGER as
    //    acting_operator_id (the authoriser). Combined with the
    //    attempts row's acting_operator_id (= cashier), this is the
    //    dual-attribution lineage the bridge handler composes into
    //    the audit payload.
    type OutboxRow = { action_kind: string; acting_operator_id: string };
    const stmt = handle.prepare(
      'SELECT action_kind, acting_operator_id FROM payment_action_outbox WHERE payment_attempt_id = ? ORDER BY action_kind',
    ) as { all(...p: unknown[]): OutboxRow[] };
    const rows = stmt.all('pa-stuck');
    const startOutbox = rows.find((r) => r.action_kind === 'payment.attempt.start');
    const forceFailOutbox = rows.find((r) => r.action_kind === 'payment.force_fail');
    expect(startOutbox?.acting_operator_id).toBe(CASHIER);
    expect(forceFailOutbox?.acting_operator_id).toBe(MANAGER);
  });

  it('FR-021 — FSM bridge-response shape does NOT echo manager identity', () => {
    // The cashier-visible bridge response (PaymentsForceFailResponse)
    // is what the renderer consumes. The FSM outcome maps 1:1 onto
    // the bridge `kind: 'ok'` shape: only kind + force_failed_at.
    // The manager_operator_id MUST stay main-side (FR-021 last clause —
    // "manager identity never in cashier-visible DOM").
    const { attemptFsm } = buildStack();

    attemptFsm.start({
      payment_attempt_id: 'pa-shape',
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      acting_operator_id: CASHIER,
      operator_session_id: CASHIER_SESSION,
      envelope_handoff_action_id: 'handoff-shape',
      envelope_cart_id: 'cart-shape',
      envelope_subtotal_minor: 1500,
      started_at: '2026-05-25T11:00:00.000Z',
      action_id: 'start-pa-shape',
    });
    const result = attemptFsm.forceFail({
      payment_attempt_id: 'pa-shape',
      force_failed_at: '2026-05-25T11:45:30.000Z',
      manager_operator_id: MANAGER,
      action_id: 'force-fail-pa-shape',
    });
    // The FSM outcome (which the handler returns verbatim on the ok
    // path) has exactly two fields and the manager id is NOT one of
    // them. We assert the serialized shape so any future leak via a
    // toJSON / structuredClone path also fails this test.
    expect(result).toEqual({ kind: 'ok', force_failed_at: '2026-05-25T11:45:30.000Z' });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(MANAGER);
    expect(serialised).not.toContain('manager_operator_id');
    expect(serialised).not.toContain('force_fail_attribution_operator_id');
  });

  it('force-fail of an already-terminal attempt is refused (defence-in-depth)', () => {
    const { attemptFsm } = buildStack();
    attemptFsm.start({
      payment_attempt_id: 'pa-terminal',
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      acting_operator_id: CASHIER,
      operator_session_id: CASHIER_SESSION,
      envelope_handoff_action_id: 'handoff-terminal',
      envelope_cart_id: 'cart-terminal',
      envelope_subtotal_minor: 1000,
      started_at: '2026-05-25T11:00:00.000Z',
      action_id: 'start-pa-terminal',
    });
    // Cancel it so it lands in a terminal state.
    const cancelResult = attemptFsm.cancel({
      payment_attempt_id: 'pa-terminal',
      cancelled_at: '2026-05-25T11:10:00.000Z',
      action_id: 'cancel-pa-terminal',
    });
    expect(cancelResult.kind).toBe('ok');
    // Now the manager tries to force-fail it — FSM refuses.
    const forceFail = attemptFsm.forceFail({
      payment_attempt_id: 'pa-terminal',
      force_failed_at: '2026-05-25T11:45:00.000Z',
      manager_operator_id: MANAGER,
      action_id: 'force-fail-terminal',
    });
    expect(forceFail.kind).toBe('refused');
    if (forceFail.kind === 'refused') {
      expect(forceFail.reason).toBe('attempt_terminal');
    }
  });
});
