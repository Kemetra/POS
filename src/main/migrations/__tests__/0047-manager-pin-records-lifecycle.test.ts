/**
 * RT-438 (MA-1) — migration-shape test for `0047_manager_pin_records_lifecycle`
 * ([GATED], owner-approved 2026-10-12, RT-438 comment 11738).
 *
 * Asserts on the full migration stack (sql.js):
 *   • it takes the number right after 0046, and only it does;
 *   • it appends four lifecycle columns to `manager_pin_records` after 0044's
 *     twelve, and alters nothing else;
 *   • an existing row reads as active: no lockouts, not disabled, not revoked;
 *   • the lockout count is a non-negative integer, the stamps are non-empty,
 *     and the revoke reason is the closed set;
 *   • the record's key stays immutable (0044's trigger still holds);
 *   • the real runner applies it once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database as SqlJsDatabase } from 'sql.js';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  MIGRATIONS_DIR,
  freshGrantDb,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';

const MIGRATION = '0047_manager_pin_records_lifecycle';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');
const BEFORE_0047 = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql') && f < `${MIGRATION}.sql`)
  .sort((a, b) => a.localeCompare(b));

const USER_ID = '0190f5a2-3b4c-7d8e-9f01-23456789abce';
const REF = '7f3c1e2a-0b4d-4c5e-8f60-123456789abc';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(() => {
  db = freshGrantDb();
});

afterEach(() => {
  db.close();
});

function columns(table: string): string[] {
  return (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((r) => String(r[1]));
}

function insertRow(over: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | Uint8Array | null> = {
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    user_id: USER_ID,
    manager_ref: REF,
    display_name: 'Mona Manager',
    pin_hash: new Uint8Array([1, 2, 3]),
    pin_salt: new Uint8Array([4, 5, 6]),
    enrolled_at: '2026-10-12T08:00:00.000Z',
    last_online_at: '2026-10-12T08:00:00.000Z',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO manager_pin_records (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(row),
  );
}

describe('0047 — manager PIN record lifecycle (RT-438, [GATED])', () => {
  it('takes the number right after 0046, and only it does', () => {
    expect(BEFORE_0047[BEFORE_0047.length - 1]).toBe('0046_carts_owner_key_index.sql');
    const names = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith('0047_'));
    expect(names).toEqual([`${MIGRATION}.sql`]);
  });

  it("appends exactly four columns after 0044's twelve", () => {
    const all = columns('manager_pin_records');
    // RT-861: 0056 appends `role` after them.
    expect(all.slice(12, 16)).toEqual([
      'lockout_count',
      'disabled_at',
      'revoked_at',
      'revoke_reason',
    ]);
    expect(all.slice(16)).toEqual(['role']);
  });

  it('a row written before 0047 reads as active', () => {
    const old = new (db.constructor as new () => SqlJsDatabase)();
    old.exec('PRAGMA foreign_keys = ON;');
    for (const name of BEFORE_0047) old.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
    old.run(
      `INSERT INTO manager_pin_records
         (tenant_id, branch_id, terminal_id, user_id, manager_ref, display_name,
          pin_hash, pin_salt, enrolled_at, last_online_at)
       VALUES ('t', 'b', 'term', ?, ?, 'M', ?, ?, 'x', 'y')`,
      [USER_ID, REF, new Uint8Array([1]), new Uint8Array([2])],
    );
    old.exec(SQL_TEXT);
    expect(
      old.exec(
        'SELECT lockout_count, disabled_at, revoked_at, revoke_reason FROM manager_pin_records',
      )[0]?.values,
    ).toEqual([[0, null, null, null]]);
    old.close();
  });

  it('refuses a negative or non-integer lockout count', () => {
    expect(() => {
      insertRow({ lockout_count: -1 });
    }).toThrow(/CHECK/);
    expect(() => {
      insertRow({ lockout_count: 1.5 });
    }).toThrow(/CHECK/);
  });

  it.each(['disabled_at', 'revoked_at'])('refuses an empty %s', (column) => {
    expect(() => {
      insertRow({ [column]: '' });
    }).toThrow(/CHECK/);
  });

  it.each(['self', 'other_manager', 'ineligible'])('accepts the revoke reason %s', (reason) => {
    insertRow({ revoked_at: '2026-10-12T09:00:00.000Z', revoke_reason: reason });
  });

  it('refuses a revoke reason outside the closed set', () => {
    expect(() => {
      insertRow({ revoked_at: '2026-10-12T09:00:00.000Z', revoke_reason: 'manual' });
    }).toThrow(/CHECK/);
  });

  it('keeps the record key immutable', () => {
    insertRow();
    expect(() => {
      db.run(`UPDATE manager_pin_records SET user_id = 'other'`);
    }).toThrow(/immutable/);
  });

  it('applies exactly once through the real runner', () => {
    const fresh = new (db.constructor as new () => SqlJsDatabase)();
    for (const name of BEFORE_0047)
      fresh.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
    const applied: string[] = [];
    const runnerDb: MigrationsDb = {
      exec: (sql) => {
        fresh.exec(sql);
      },
      listAppliedNames: () => applied,
      recordApplied: (row) => applied.push(row.name),
      transaction: (fn) => fn(),
    };
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    fresh.close();
  });
});
