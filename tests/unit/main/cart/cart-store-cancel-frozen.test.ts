/**
 * `CartStore.cancelFrozenCartAndOutbox` — the one-transaction post-handoff
 * cancel. Direct store tests for every branch: not frozen at entry, payment
 * check refuses, the update finds the cart no longer frozen, success without
 * an `onInserted` hook, and an unexpected error propagating after rollback.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bindCartStore, type CartStore } from '../../../../src/main/cart/cart-store.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const NOW = '2026-09-26T09:00:00.000Z';

function setup(state: string): { db: SqlJsDatabase; store: CartStore } {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  db.run(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
       state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
       cancellation_reason, handoff_envelope_json, last_action_id
     ) VALUES ('cart-1', 't', 'b', 'term', 'op', 'sess', ?, 0, ?, ?, NULL, NULL, NULL, NULL, 'a0')`,
    [state, NOW, NOW],
  );
  return { db, store: bindCartStore(makeSqlJsHandle(db)) };
}

const cancel = {
  cart_id: 'cart-1',
  cancelled_at: NOW,
  cancellation_reason: 'manager_voided_post_handoff',
  last_action_id: 'k-1',
  updated_at: NOW,
};
const outbox = {
  action_id: 'k-1',
  cart_id: 'cart-1',
  line_id: null,
  action_kind: 'cart.cancel.post_handoff',
  acting_operator_id: 'mgr',
  attribution_operator_id: null,
  operator_session_id: 'sess-m',
  payload_json: '{}',
  applied_at: NOW,
};

function stateOf(db: SqlJsDatabase): unknown {
  const stmt = db.prepare(`SELECT state FROM carts WHERE cart_id = 'cart-1'`);
  stmt.step();
  const v = stmt.getAsObject()['state'];
  stmt.free();
  return v;
}

function outboxCount(db: SqlJsDatabase): unknown {
  const stmt = db.prepare(`SELECT COUNT(*) AS n FROM cart_action_outbox`);
  stmt.step();
  const v = stmt.getAsObject()['n'];
  stmt.free();
  return v;
}

describe('CartStore.cancelFrozenCartAndOutbox', () => {
  it('cancels a frozen cart and writes its outbox row (no onInserted hook)', () => {
    const { db, store } = setup('frozen_handed_off');
    expect(store.cancelFrozenCartAndOutbox(cancel, outbox, () => true)).toBe(true);
    expect(stateOf(db)).toBe('cancelled');
    expect(outboxCount(db)).toBe(1);
  });

  it('returns false and writes nothing for a cart that is not frozen', () => {
    const { db, store } = setup('editing');
    let asked = false;
    const ok = store.cancelFrozenCartAndOutbox(cancel, outbox, () => {
      asked = true;
      return true;
    });
    expect(ok).toBe(false);
    expect(asked).toBe(false);
    expect(stateOf(db)).toBe('editing');
    expect(outboxCount(db)).toBe(0);
  });

  it('returns false and writes nothing when the payment check refuses', () => {
    const { db, store } = setup('frozen_handed_off');
    expect(store.cancelFrozenCartAndOutbox(cancel, outbox, () => false)).toBe(false);
    expect(stateOf(db)).toBe('frozen_handed_off');
    expect(outboxCount(db)).toBe(0);
  });

  it('rolls back and propagates an unexpected error from inside the transaction', () => {
    const { db, store } = setup('frozen_handed_off');
    expect(() =>
      store.cancelFrozenCartAndOutbox(
        cancel,
        outbox,
        () => true,
        () => {
          throw new Error('audit write failed');
        },
      ),
    ).toThrow('audit write failed');
    expect(stateOf(db)).toBe('frozen_handed_off');
    expect(outboxCount(db)).toBe(0);
  });
});
