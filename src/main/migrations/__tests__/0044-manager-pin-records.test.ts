/**
 * RT-17 slice 4 part 2 — migration-shape test for `0044_manager_pin_records`
 * ([GATED], option A approved by the owner on 2026-10-06, Jira RT-17 comment
 * 10943).
 *
 * Runs the full migration stack on sql.js and asserts:
 *   • one row per (tenant, branch, terminal, users.id): the cashier PIN
 *     records' scope (0036), keyed on the manager's provider-neutral id;
 *   • the id is stored lower-cased (RT-17 10934) and nothing may be empty;
 *   • the secret columns are non-empty BLOBs (a sealed Argon2id PHC string and
 *     its salt), never text;
 *   • the lockout columns mirror `cashier_pin_records`: an integer count ≥ 0
 *     and an optional instant;
 *   • a row's key can never be re-pointed at another manager or scope;
 *   • nothing existing is altered, and the real runner applies it once.
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

const MIGRATION = '0044_manager_pin_records';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const USER_ID = '0190f5a2-3b4c-7d8e-9f01-23456789abce';
const HASH = new Uint8Array([1, 2, 3]);
const SALT = new Uint8Array([4, 5, 6]);

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

type Value = string | number | Uint8Array | null;

function insertRow(over: Record<string, Value> = {}): void {
  const row: Record<string, Value> = {
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    user_id: USER_ID,
    pin_hash: HASH,
    pin_salt: SALT,
    failed_attempt_count: 0,
    lockout_until: null,
    enrolled_at: '2026-10-06T08:00:00.000Z',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO manager_pin_records (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] as Value),
  );
}

function count(): unknown {
  return db.exec('SELECT COUNT(*) FROM manager_pin_records')[0]?.values[0]?.[0];
}

describe('0044 — manager PIN records (RT-17 slice 4 part 2, [GATED] 10943)', () => {
  it('takes the number right after 0043, and only it does', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(names[i - 1]).toBe('0043_shift_cash_up.sql');
    expect(names.filter((n) => n.startsWith('0044_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('has the scope, the users.id, the sealed secret, the lockout state and a stamp only', () => {
    expect(columns('manager_pin_records')).toEqual([
      'tenant_id',
      'branch_id',
      'terminal_id',
      'user_id',
      'pin_hash',
      'pin_salt',
      'failed_attempt_count',
      'lockout_until',
      'enrolled_at',
    ]);
  });

  it('keys a record on (tenant, branch, terminal, users.id)', () => {
    insertRow();
    expect(() => {
      insertRow();
    }).toThrow(/UNIQUE|PRIMARY/);
    insertRow({ user_id: '0190f5a2-3b4c-7d8e-9f01-000000000002' });
    insertRow({ terminal_id: 'term2' });
    insertRow({ branch_id: 'b2' });
    insertRow({ tenant_id: 't2' });
    expect(count()).toBe(5);
  });

  it('defaults a new record to no failed attempt and no lockout', () => {
    db.run(
      `INSERT INTO manager_pin_records
         (tenant_id, branch_id, terminal_id, user_id, pin_hash, pin_salt, enrolled_at)
       VALUES ('t', 'b', 'term', ?, ?, ?, 'x')`,
      [USER_ID, HASH, SALT],
    );
    expect(
      db.exec('SELECT failed_attempt_count, lockout_until FROM manager_pin_records')[0]?.values,
    ).toEqual([[0, null]]);
  });

  it('refuses an upper-case users.id (ids are stored lower-cased)', () => {
    expect(() => {
      insertRow({ user_id: USER_ID.toUpperCase() });
    }).toThrow(/CHECK/);
  });

  it.each(['tenant_id', 'branch_id', 'terminal_id', 'user_id', 'enrolled_at'])(
    'refuses an empty %s',
    (col) => {
      expect(() => {
        insertRow({ [col]: '' });
      }).toThrow(/CHECK/);
    },
  );

  it.each(['tenant_id', 'branch_id', 'terminal_id', 'user_id', 'pin_hash', 'pin_salt'])(
    'refuses a NULL %s',
    (col) => {
      expect(() => {
        insertRow({ [col]: null });
      }).toThrow(/NOT NULL/);
    },
  );

  it.each([
    ['an empty blob', new Uint8Array([])],
    ['text', '$argon2id$v=19$m=65536,t=3,p=1$abc$def'],
    ['an integer', 7],
  ])('refuses %s as the PIN hash or salt', (_label, value) => {
    expect(() => {
      insertRow({ pin_hash: value });
    }).toThrow(/CHECK/);
    expect(() => {
      insertRow({ pin_salt: value });
    }).toThrow(/CHECK/);
  });

  it.each([
    ['a negative count', -1],
    ['a fractional count', 1.5],
    ['a text count', 'one'],
  ])('refuses %s of failed attempts', (_label, value) => {
    expect(() => {
      insertRow({ failed_attempt_count: value });
    }).toThrow(/CHECK/);
  });

  it('refuses an empty lockout instant (NULL is no lockout)', () => {
    expect(() => {
      insertRow({ lockout_until: '' });
    }).toThrow(/CHECK/);
    insertRow({ lockout_until: '2026-10-06T08:05:00.000Z' });
    expect(count()).toBe(1);
  });

  it('lets the secret and the lockout state change (re-enrolment, attempts)', () => {
    insertRow();
    db.run(
      `UPDATE manager_pin_records
          SET pin_hash = ?, pin_salt = ?, failed_attempt_count = 3,
              lockout_until = '2026-10-06T08:05:00.000Z', enrolled_at = 'y'`,
      [new Uint8Array([9]), new Uint8Array([8])],
    );
    expect(
      db.exec('SELECT failed_attempt_count, enrolled_at FROM manager_pin_records')[0]?.values,
    ).toEqual([[3, 'y']]);
  });

  it.each(['tenant_id', 'branch_id', 'terminal_id', 'user_id'])(
    'never re-points a record’s key (%s is immutable)',
    (col) => {
      insertRow();
      expect(() => {
        db.run(`UPDATE manager_pin_records SET ${col} = 'other'`);
      }).toThrow(/immutable/);
    },
  );

  it('ships empty and leaves the cashier PIN records as they were', () => {
    expect(count()).toBe(0);
    expect(columns('cashier_pin_records')).toEqual([
      'tenant_id',
      'branch_id',
      'terminal_id',
      'user_id',
      'cashier_clerk_user_id',
      'pin_hash',
      'pin_salt',
      'failed_attempt_count',
      'lockout_until',
      'created_at',
      'created_by_operator_id',
    ]);
  });

  it('applies exactly once through the real runner', () => {
    const applied: string[] = [];
    const runnerDb: MigrationsDb = {
      exec: (sql) => {
        db.exec(sql);
      },
      listAppliedNames: () => applied,
      recordApplied: (row) => applied.push(row.name),
      transaction: (fn) => fn(),
    };
    db.exec('DROP TABLE manager_pin_records;');
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    expect(columns('manager_pin_records')).toContain('pin_hash');
  });
});
