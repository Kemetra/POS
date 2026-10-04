/**
 * RT-26 — migration-shape test for `0037_cart_action_outbox_return_to_sale`.
 *
 * Runs the real 0009 then 0037 against sql.js (SQLite proper) and asserts the
 * rebuild only widens `action_kind` by 'cart.return_to_sale':
 *   • every pre-existing row survives byte-for-byte;
 *   • the new kind is accepted, an unknown kind is still refused;
 *   • columns, PK, indexes and BOTH append-only triggers are as 0009 declared.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'migrations');

function migrationSql(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

let SQL: SqlJsStatic | undefined;
let db: SqlJsDatabase;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  if (SQL === undefined) throw new Error('initSqlJs() must complete first');
  db = new SQL.Database();
  db.exec(migrationSql('0009_cart_action_outbox.sql'));
});

afterEach(() => {
  db.close();
});

function insert(actionId: string, kind: string): void {
  db.run(
    `INSERT INTO cart_action_outbox
       (action_id, cart_id, line_id, action_kind, acting_operator_id,
        attribution_operator_id, operator_session_id, payload_json, applied_at)
     VALUES (?, 'cart-1', NULL, ?, 'op-1', NULL, 'sess-1', '{"cart_id":"cart-1"}', '2026-10-04T10:00:00.000Z')`,
    [actionId, kind],
  );
}

function all(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

const ORIGINAL_KINDS = [
  'cart.create',
  'cart.line.add',
  'cart.line.update',
  'cart.line.merge',
  'cart.line.remove',
  'cart.line.note_set',
  'cart.discount_placeholder.add',
  'cart.discount_placeholder.remove',
  'cart.void',
  'cart.handoff_to_payment',
  'cart.cancel.post_handoff',
  'cart.discount.above_threshold',
  'cart.discarded_on_session_end',
];

describe('0037 — cart_action_outbox accepts cart.return_to_sale', () => {
  it('is refused by 0009 alone (the migration is what makes the kind legal)', () => {
    expect(() => {
      insert('before', 'cart.return_to_sale');
    }).toThrow(/CHECK constraint failed/);
  });

  it('preserves every existing row unchanged', () => {
    ORIGINAL_KINDS.forEach((kind, i) => {
      insert(`a-${String(i)}`, kind);
    });
    const before = all(`SELECT * FROM cart_action_outbox ORDER BY action_id`);

    db.exec(migrationSql('0037_cart_action_outbox_return_to_sale.sql'));

    expect(all(`SELECT * FROM cart_action_outbox ORDER BY action_id`)).toEqual(before);
  });

  it('accepts the new kind and every original kind, and still refuses unknown kinds', () => {
    db.exec(migrationSql('0037_cart_action_outbox_return_to_sale.sql'));
    insert('back-1', 'cart.return_to_sale');
    ORIGINAL_KINDS.forEach((kind, i) => {
      insert(`b-${String(i)}`, kind);
    });
    expect(() => {
      insert('bad', 'cart.reopen');
    }).toThrow(/CHECK constraint failed/);
  });

  it('keeps the table append-only (UPDATE and DELETE denied)', () => {
    db.exec(migrationSql('0037_cart_action_outbox_return_to_sale.sql'));
    insert('back-1', 'cart.return_to_sale');
    expect(() => {
      db.run(`UPDATE cart_action_outbox SET payload_json = '{}' WHERE action_id = 'back-1'`);
    }).toThrow(/append-only: UPDATE is denied/);
    expect(() => {
      db.run(`DELETE FROM cart_action_outbox WHERE action_id = 'back-1'`);
    }).toThrow(/append-only: DELETE is denied/);
  });

  it('keeps the 0009 columns, primary key and indexes; leaves no temp table behind', () => {
    const columnsBefore = all(`PRAGMA table_info(cart_action_outbox)`);
    db.exec(migrationSql('0037_cart_action_outbox_return_to_sale.sql'));
    expect(all(`PRAGMA table_info(cart_action_outbox)`)).toEqual(columnsBefore);

    const indexes = all(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cart_action_outbox'
         AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`,
    ).map((r) => r[0]);
    expect(indexes).toEqual([
      'idx_cart_action_outbox_action_kind',
      'idx_cart_action_outbox_cart',
      'idx_cart_action_outbox_line',
    ]);
    const triggers = all(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'cart_action_outbox'
         ORDER BY name`,
    ).map((r) => r[0]);
    expect(triggers).toEqual([
      'trg_cart_action_outbox_no_delete',
      'trg_cart_action_outbox_no_update',
    ]);
    expect(all(`SELECT name FROM sqlite_master WHERE name = 'cart_action_outbox_new'`)).toEqual([]);
  });
});
