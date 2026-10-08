/**
 * RT-26 — edge branches of the Checkout Back payments proof
 * (`bindCheckoutReturnAssessment` / `bindCheckoutReturnGuard`) that the
 * end-to-end tests cannot reach through the real handlers: states the proof
 * does not cover must refuse rather than guess, and a refused attempt cancel
 * must block the Back.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  bindCheckoutReturnAllowed,
  bindCheckoutReturnAssessment,
  bindCheckoutReturnGuard,
} from '../../../../src/main/payments/checkout-return-guard.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['0012_create_payment_attempts.sql', '0014_create_payment_tender_lines.sql'].map(
  (f) => readFileSync(path.resolve(__dirname0, '..', '..', '..', '..', 'migrations', f), 'utf8'),
);

let SQL: SqlJsStatic;
let db: SqlJsDatabase;

beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(() => {
  db = new SQL.Database();
  for (const sql of MIGRATIONS) db.exec(sql);
});
afterEach(() => {
  db.close();
});

function startedAttempt(id: string, terminal: string, handoff: string): void {
  db.run(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id, acting_operator_id,
       operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, last_action_id
     ) VALUES (?, 't', 'b', ?, 'op', 'sess', ?, 'cart-1', 100, 'started', '2026-10-04T10:00:00Z', 'a')`,
    [id, terminal, handoff],
  );
}

const REQ = { cart_id: 'cart-1', handoff_action_id: 'handoff-1' };
const RELEASE = { ...REQ, action_id: 'back-1', at: '2026-10-04T10:01:00Z', session_id: 'sess' };

function guardWith(cancel: ReturnType<typeof vi.fn>) {
  return bindCheckoutReturnGuard({
    db: makeSqlJsHandle(db),
    paymentAttemptFsm: { cancel },
    auditEmitter: { emitPaymentCancelled: vi.fn() },
  });
}

describe('checkout return proof — states it does not cover refuse', () => {
  it('blocks when the cart has more than one started attempt', () => {
    startedAttempt('pa-1', 'term-1', 'handoff-1');
    startedAttempt('pa-2', 'term-2', 'handoff-1');
    expect(bindCheckoutReturnAssessment(makeSqlJsHandle(db))(REQ)).toEqual({ kind: 'blocked' });
    expect(bindCheckoutReturnAllowed(makeSqlJsHandle(db))(REQ)).toBe(false);
  });

  it('blocks when the started attempt belongs to another handoff', () => {
    startedAttempt('pa-1', 'term-1', 'handoff-old');
    const cancel = vi.fn();
    expect(guardWith(cancel)(RELEASE)).toEqual({ kind: 'blocked' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('blocks when the payment FSM refuses to cancel the open attempt', () => {
    startedAttempt('pa-1', 'term-1', 'handoff-1');
    const cancel = vi.fn(() => ({ kind: 'refused', reason: 'attempt_terminal' }));
    expect(guardWith(cancel)(RELEASE)).toEqual({ kind: 'blocked' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('is clear with no attempts at all, and the read form agrees', () => {
    expect(bindCheckoutReturnAssessment(makeSqlJsHandle(db))(REQ)).toEqual({
      kind: 'clear',
      open: null,
    });
    expect(bindCheckoutReturnAllowed(makeSqlJsHandle(db))(REQ)).toBe(true);
  });
});
