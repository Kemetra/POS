import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T036 — `cart_action_outbox` append-only invariant.
 *
 * The migration installs a trigger pair (`trg_cart_action_outbox_no_update`,
 * `trg_cart_action_outbox_no_delete`) that raises ABORT on any UPDATE or
 * DELETE. Mirrors the pattern in `migrations/0004_audit_events.sql`. This
 * test runs the real migration SQL via sql.js and asserts the triggers
 * fire on raw SQL.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const CARTS_SQL = readFileSync(path.join(REPO_ROOT, 'migrations', '0008_carts.sql'), 'utf8');
const OUTBOX_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0009_cart_action_outbox.sql'),
  'utf8',
);

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(CARTS_SQL);
  db.run(OUTBOX_SQL);
  // Seed one row so UPDATE/DELETE have a target.
  db.run(
    `INSERT INTO cart_action_outbox
       (action_id, cart_id, line_id, action_kind, acting_operator_id,
        attribution_operator_id, operator_session_id, payload_json, applied_at)
     VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
    ['act-1', 'cart-1', 'cart.create', 'op-1', 'sess-1', '{}', '2026-05-14T10:00:00Z'],
  );
  return db;
}

describe('cart_action_outbox is append-only (T036)', () => {
  it('UPDATE on cart_action_outbox raises ABORT with the append-only message', () => {
    const db = freshDb();
    expect(() =>
      db.run(`UPDATE cart_action_outbox SET payload_json = '{}' WHERE action_id = 'act-1'`),
    ).toThrow(/append-only.*UPDATE is denied/i);
    db.close();
  });

  it('DELETE on cart_action_outbox raises ABORT with the append-only message', () => {
    const db = freshDb();
    expect(() => db.run(`DELETE FROM cart_action_outbox WHERE action_id = 'act-1'`)).toThrow(
      /append-only.*DELETE is denied/i,
    );
    db.close();
  });

  it('INSERT on cart_action_outbox is allowed (sanity)', () => {
    const db = freshDb();
    expect(() =>
      db.run(
        `INSERT INTO cart_action_outbox
           (action_id, cart_id, line_id, action_kind, acting_operator_id,
            attribution_operator_id, operator_session_id, payload_json, applied_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
        ['act-2', 'cart-1', 'cart.line.add', 'op-1', 'sess-1', '{}', '2026-05-14T10:01:00Z'],
      ),
    ).not.toThrow();
    db.close();
  });
});

describe('mutable cart tables (T036 regression — append-only is scoped)', () => {
  it('UPDATE on carts succeeds (carts is intentionally mutable)', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id,
         owning_operator_id, operator_session_id, state, created_at, updated_at)
       VALUES ('c1', 't', 'b', 'term', 'op', 'sess', 'empty', '2026-05-14T10:00:00Z', '2026-05-14T10:00:00Z')`,
    );
    expect(() => db.run(`UPDATE carts SET state = 'editing' WHERE cart_id = 'c1'`)).not.toThrow();
    db.close();
  });
});
