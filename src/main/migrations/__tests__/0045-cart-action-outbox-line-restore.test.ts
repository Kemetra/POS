/**
 * RT-254 — migration-shape test for `0045_cart_action_outbox_line_restore`.
 *
 * Runs the real 0009 → 0037 → 0045 chain against sql.js (SQLite proper) and
 * asserts the rebuild only widens `action_kind` by 'cart.line.restore':
 *   • every pre-existing row survives byte-for-byte, rowid included;
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

const M0045 = '0045_cart_action_outbox_line_restore.sql';

let SQL: SqlJsStatic | undefined;
let db: SqlJsDatabase;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  if (SQL === undefined) throw new Error('initSqlJs() must complete first');
  db = new SQL.Database();
  db.exec(migrationSql('0009_cart_action_outbox.sql'));
  db.exec(migrationSql('0037_cart_action_outbox_return_to_sale.sql'));
});

afterEach(() => {
  db.close();
});

function insert(actionId: string, kind: string, lineId: string | null = null): void {
  db.run(
    `INSERT INTO cart_action_outbox
       (action_id, cart_id, line_id, action_kind, acting_operator_id,
        attribution_operator_id, operator_session_id, payload_json, applied_at)
     VALUES (?, 'cart-1', ?, ?, 'op-1', NULL, 'sess-1', '{"k":1}', '2026-10-10T10:00:00.000Z')`,
    [actionId, lineId, kind],
  );
}

function all(sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

const KINDS_BEFORE_0045 = [
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
  'cart.return_to_sale',
];

describe('0045 — cart_action_outbox accepts cart.line.restore', () => {
  it('is refused by 0009 + 0037 alone (the migration is what makes the kind legal)', () => {
    expect(() => {
      insert('before', 'cart.line.restore', 'line-1');
    }).toThrow(/CHECK constraint failed/);
  });

  it('preserves every existing row unchanged, including its rowid and order', () => {
    // Insert in an order that differs from action_id order so a rowid
    // renumbering would be visible.
    [...KINDS_BEFORE_0045].reverse().forEach((kind, i) => {
      insert(`z-${String(KINDS_BEFORE_0045.length - i)}`, kind, i % 2 === 0 ? 'line-1' : null);
    });
    const before = all(`SELECT rowid, * FROM cart_action_outbox ORDER BY rowid`);
    expect(before).toHaveLength(KINDS_BEFORE_0045.length);

    db.exec(migrationSql(M0045));

    expect(all(`SELECT rowid, * FROM cart_action_outbox ORDER BY rowid`)).toEqual(before);
  });

  it('keeps rowid gaps (no renumbering on rebuild)', () => {
    insert('a', 'cart.create');
    db.run(
      `INSERT INTO cart_action_outbox (rowid, action_id, cart_id, line_id, action_kind,
         acting_operator_id, attribution_operator_id, operator_session_id, payload_json, applied_at)
       VALUES (50, 'b', 'cart-1', 'line-1', 'cart.line.add', 'op-1', NULL, 'sess-1', '{}', 't')`,
    );
    db.exec(migrationSql(M0045));
    expect(all(`SELECT rowid, action_id FROM cart_action_outbox ORDER BY rowid`)).toEqual([
      [1, 'a'],
      [50, 'b'],
    ]);
    // New rows continue after the highest preserved rowid.
    insert('c', 'cart.line.restore', 'line-1');
    expect(all(`SELECT rowid FROM cart_action_outbox WHERE action_id = 'c'`)).toEqual([[51]]);
  });

  it('accepts the new kind and every earlier kind, and still refuses unknown kinds', () => {
    db.exec(migrationSql(M0045));
    insert('restore-1', 'cart.line.restore', 'line-1');
    KINDS_BEFORE_0045.forEach((kind, i) => {
      insert(`b-${String(i)}`, kind);
    });
    expect(() => {
      insert('bad', 'cart.line.undo');
    }).toThrow(/CHECK constraint failed/);
  });

  it('keeps the table append-only (UPDATE and DELETE denied)', () => {
    db.exec(migrationSql(M0045));
    insert('restore-1', 'cart.line.restore', 'line-1');
    expect(() => {
      db.run(`UPDATE cart_action_outbox SET payload_json = '{}' WHERE action_id = 'restore-1'`);
    }).toThrow(/append-only: UPDATE is denied/);
    expect(() => {
      db.run(`DELETE FROM cart_action_outbox WHERE action_id = 'restore-1'`);
    }).toThrow(/append-only: DELETE is denied/);
  });

  it('keeps the columns, primary key and indexes; leaves no temp table behind', () => {
    const columnsBefore = all(`PRAGMA table_info(cart_action_outbox)`);
    db.exec(migrationSql(M0045));
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
