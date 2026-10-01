import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import { createLockStateReader } from '../../../../src/main/operator/lock-state-reader.js';

/**
 * RT-117 (RT-116 §7.2) — `operator.getLockState()`: the only read served while
 * locked. It reports the preserved sale as TOTALS ONLY (line count, total,
 * applied tender, live-tender flag) for the lock screen — never line items,
 * names or credentials.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(dir, '..', '..', '..', '..');
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
  '0018_audit_event_tender_reversal_pending.sql',
  '0019_extend_payment_failure_reason_enum.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

const NOW = '2026-10-01T10:00:00.000Z';
const TERMINAL = 'term-1';

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

function signedIn(role: 'cashier' | 'manager' = 'cashier'): SessionManager {
  const sm = new SessionManager();
  sm.create({
    operator_id: 'op-1',
    display_name: 'Cashier One',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    started_at: NOW,
  });
  return sm;
}

function insertCart(cart_id: string, session_id: string, state: string, subtotal: number): void {
  db.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, created_at, updated_at)
     VALUES (?, 't1', 'b1', ?, 'op-1', ?, ?, ?, ?, ?)`,
    [cart_id, TERMINAL, session_id, state, subtotal, NOW, NOW],
  );
}

function insertLine(line_id: string, cart_id: string, subtotal: number, removed = false): void {
  db.run(
    `INSERT INTO cart_lines (line_id, cart_id, item_ref, display_name, quantity,
       unit_price_minor, line_subtotal_minor, last_action_id, created_at, updated_at, removed_at)
     VALUES (?, ?, 'SKU', 'Item', 1, ?, ?, 'a', ?, ?, ?)`,
    [line_id, cart_id, subtotal, subtotal, NOW, NOW, removed ? NOW : null],
  );
}

function insertStartedAttempt(id: string, session_id: string, cart_id: string): void {
  db.run(
    `INSERT INTO payment_attempts (payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, last_action_id)
     VALUES (?, 't1', 'b1', ?, 'op-1', ?, 'h1', ?, 2550, 'started', ?, 'a')`,
    [id, TERMINAL, session_id, cart_id, NOW],
  );
}

function insertTender(
  id: string,
  attempt: string,
  type: string,
  amount: number,
  state: string,
): void {
  db.run(
    `INSERT INTO payment_tender_lines (tender_line_id, payment_attempt_id, tender_type,
       amount_applied_minor, state, attribution_operator_id, apply_order, last_action_id)
     VALUES (?, ?, ?, ?, ?, 'op-1', 1, 'a')`,
    [id, attempt, type, amount, state],
  );
}

function reader(sm: SessionManager) {
  return createLockStateReader({
    db: makeSqlJsHandle(db),
    sessionManager: sm,
    resolveTerminalId: () => TERMINAL,
  });
}

describe('RT-117 createLockStateReader', () => {
  it('reports signed_out with no summary when there is no session', () => {
    expect(reader(new SessionManager())()).toEqual({
      state: 'signed_out',
      locked_at: null,
      role: null,
      display_name: null,
      summary: null,
    });
  });

  it('reports the locked state, role and a null summary when there is no open cart', () => {
    const sm = signedIn();
    sm.lock('2026-10-01T10:10:00.000Z');

    expect(reader(sm)()).toEqual({
      state: 'locked',
      locked_at: '2026-10-01T10:10:00.000Z',
      role: 'cashier',
      display_name: 'Cashier One',
      summary: null,
    });
  });

  it('summarizes a draft cart as totals only (removed lines excluded)', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart('cart-1', sid, 'editing', 5275);
    insertLine('l1', 'cart-1', 2000);
    insertLine('l2', 'cart-1', 725);
    insertLine('l3', 'cart-1', 2550);
    insertLine('l4', 'cart-1', 999, true);
    sm.lock('2026-10-01T10:10:00.000Z');

    expect(reader(sm)().summary).toEqual({
      line_count: 3,
      total_minor: 5275,
      tender_applied_minor: 0,
      has_live_tender: false,
    });
  });

  it('includes applied tender and the live-tender flag for a handed-off cart', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart('cart-1', sid, 'frozen_handed_off', 2550);
    insertLine('l1', 'cart-1', 2550);
    insertStartedAttempt('pa-1', sid, 'cart-1');
    insertTender('tl-1', 'pa-1', 'cash', 1000, 'applied');
    insertTender('tl-2', 'pa-1', 'cash', 500, 'refused');
    sm.lock('2026-10-01T10:10:00.000Z');

    expect(reader(sm)().summary).toEqual({
      line_count: 1,
      total_minor: 2550,
      tender_applied_minor: 1000,
      has_live_tender: true,
    });
  });

  it("ignores another session's cart", () => {
    const sm = signedIn();
    insertCart('cart-other', 'some-other-session', 'editing', 9999);
    insertLine('l1', 'cart-other', 9999);

    expect(reader(sm)().summary).toBeNull();
  });

  it('ignores a cancelled cart', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart('cart-1', sid, 'cancelled', 500);

    expect(reader(sm)().summary).toBeNull();
  });

  // A settled sale keeps its cart `frozen_handed_off` (005 has no completed
  // state). Locking on the completion screen must not present that finished
  // sale as an open, preserved one.
  it('does not summarize a cart whose sale already settled', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart('cart-done', sid, 'frozen_handed_off', 2550);
    insertLine('l1', 'cart-done', 2550);
    db.run(
      `INSERT INTO payment_attempts (payment_attempt_id, tenant_id, branch_id, terminal_id,
         acting_operator_id, operator_session_id, envelope_handoff_action_id, envelope_cart_id,
         envelope_subtotal_minor, state, started_at, settled_at, last_action_id)
       VALUES ('pa-done', 't1', 'b1', ?, 'op-1', ?, 'h1', 'cart-done', 2550, 'settled', ?, ?, 'a')`,
      [TERMINAL, sid, NOW, NOW],
    );

    expect(reader(sm)().summary).toBeNull();
  });

  it('does not summarize an empty cart', () => {
    const sm = signedIn();
    const sid = sm.getCurrent()?.id ?? '';
    insertCart('cart-empty', sid, 'empty', 0);

    expect(reader(sm)().summary).toBeNull();
  });

  it('reports active for an unlocked session', () => {
    const sm = signedIn('manager');
    expect(reader(sm)()).toMatchObject({ state: 'active', locked_at: null, role: 'manager' });
  });
});
