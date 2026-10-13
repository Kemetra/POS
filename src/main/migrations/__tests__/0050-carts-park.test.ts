/**
 * RT-440 (PK-2, spec 024 K5 / R-7) — `0050_carts_park` ([GATED], owner-approved
 * 2026-10-12), on the full stack:
 *   • the number right after 0049, and only it;
 *   • existing carts survive and read as not parked;
 *   • the label is at most 40 characters;
 *   • the partial index exists;
 *   • `cart_park_actions` is append-only and accepts only park / resume.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';

import {
  MIGRATIONS_DIR,
  freshGrantDb,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0050_carts_park';
const NOW = '2026-10-13T09:00:00.000Z';

let db: SqlJsDatabase;
let SQL: SqlJsStatic;

beforeAll(async () => {
  await initGrantSql();
  SQL = await initSqlJs();
});

beforeEach(() => {
  db = freshGrantDb();
});

afterEach(() => {
  db.close();
});

const value = (sql: string): unknown => db.exec(sql)[0]?.values[0]?.[0];

const sortedMigrations = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

function insertCart(cart_id: string, label: string | null = null): void {
  db.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, created_at, updated_at, last_action_id,
       parked_at, park_label)
     VALUES (?, 't', 'b', 'term', 'op', 's', 'editing', 100, ?, ?, 'a', ?, ?)`,
    [cart_id, NOW, NOW, label === null ? null : NOW, label],
  );
}

function recordAction(key: string, kind: string): void {
  db.run(
    `INSERT INTO cart_park_actions (idempotency_key, cart_id, action_kind, request_hash,
       outcome_json, applied_at) VALUES (?, 'c', ?, 'h', '{}', ?)`,
    [key, kind, NOW],
  );
}

describe('0050 — Park v1 columns, index and idempotency table', () => {
  it('takes the number right after 0049, and only it does', () => {
    const names = sortedMigrations();
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(names[i - 1]).toBe('0049_carts_manager_cancelled_held.sql');
    expect(names.filter((n) => n.startsWith('0050_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('keeps rows written before it, which read as not parked', () => {
    const before = new SQL.Database();
    for (const name of sortedMigrations().filter((n) => n < `${MIGRATION}.sql`)) {
      before.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
    }
    before.run(
      `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
         operator_session_id, state, cart_subtotal_minor, created_at, updated_at)
       VALUES ('c-old', 't', 'b', 'term', 'op', 's', 'editing', 100, ?, ?)`,
      [NOW, NOW],
    );
    before.exec(readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8'));
    expect(
      before.exec(`SELECT parked_at, park_label, cart_subtotal_minor FROM carts`)[0]?.values,
    ).toEqual([[null, null, 100]]);
    before.close();
  });

  it('accepts a 40-character label and refuses a 41-character one', () => {
    insertCart('c-40', 'x'.repeat(40));
    expect(value(`SELECT length(park_label) FROM carts WHERE cart_id = 'c-40'`)).toBe(40);
    expect(() => {
      insertCart('c-41', 'x'.repeat(41));
    }).toThrow(/CHECK constraint failed/);
  });

  it('creates the partial index for parked carts', () => {
    expect(
      value(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_carts_parked'`),
    ).toMatch(/WHERE parked_at IS NOT NULL AND state = 'editing'/);
  });

  it('records park and resume keys only, append-only', () => {
    recordAction('k-1', 'cart.park');
    recordAction('k-2', 'cart.resume');
    expect(() => {
      recordAction('k-3', 'cart.void');
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      recordAction('k-1', 'cart.park');
    }).toThrow(/UNIQUE constraint failed/);
    expect(() => {
      db.run(`UPDATE cart_park_actions SET outcome_json = 'x'`);
    }).toThrow(/append-only: UPDATE is denied/);
    expect(() => {
      db.run(`DELETE FROM cart_park_actions`);
    }).toThrow(/append-only: DELETE is denied/);
  });
});
