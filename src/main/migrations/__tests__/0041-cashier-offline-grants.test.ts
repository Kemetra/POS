/**
 * RT-113 P1.1 — migration-shape test for `0041_create_cashier_offline_grants`
 * ([GATED], approved in Jira RT-113 comment 10874).
 *
 * Runs the full migration stack on sql.js and asserts:
 *   • `cashier_offline_grants`: one row per (tenant, branch, terminal, user_id);
 *     the only trusted content is a non-empty sealed BLOB. There is no plain
 *     counter or invalidation column to edit (OD3), and a row without a sealed
 *     body (a provisioning-only or NULL-body row, OD2) cannot be inserted;
 *   • `cashier_offline_clock_hwm`: a single row (id = 1) holding a sealed body;
 *   • nothing existing is altered (`cashier_pin_records`, `terminal_assignment`);
 *   • through the real runner it applies exactly once.
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

const MIGRATION = '0041_create_cashier_offline_grants';
const SQL_TEXT = readFileSync(path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8');

const BODY = new Uint8Array([1, 2, 3]);

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

function insertGrant(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    user_id: 'u',
    sealed_body: BODY,
    sealed_at: '2026-10-05T08:00:00.000Z',
    ...over,
  };
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO cashier_offline_grants (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k] as string | Uint8Array | null),
  );
}

function count(table: string): unknown {
  return db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0];
}

describe('0041 — cashier offline grants (RT-113 P1.1)', () => {
  it('takes the number right after 0040, and only it does (OD9)', () => {
    const names = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));
    const i = names.indexOf(`${MIGRATION}.sql`);
    expect(names[i - 1]).toBe('0040_create_return_payouts.sql');
    expect(names.filter((n) => n.startsWith('0041_'))).toEqual([`${MIGRATION}.sql`]);
  });

  it('creates cashier_offline_grants with only key columns, the sealed body and a diagnostic stamp', () => {
    expect(columns('cashier_offline_grants')).toEqual([
      'tenant_id',
      'branch_id',
      'terminal_id',
      'user_id',
      'sealed_body',
      'sealed_at',
    ]);
  });

  it('keeps the counter and the invalidation state out of plain columns (OD3)', () => {
    const cols = columns('cashier_offline_grants').join(' ');
    expect(cols).not.toMatch(/used|count|invalid|reason|expires|ttl|display|operator/);
  });

  it('keys a grant on (tenant, branch, terminal, user_id)', () => {
    insertGrant();
    expect(() => {
      insertGrant();
    }).toThrow(/UNIQUE|PRIMARY/);
    insertGrant({ user_id: 'u2' });
    insertGrant({ terminal_id: 'term2' });
    insertGrant({ branch_id: 'b2' });
    insertGrant({ tenant_id: 't2' });
    expect(count('cashier_offline_grants')).toBe(5);
  });

  it('refuses a row without a sealed body: NULL or provisioning-only (OD2)', () => {
    expect(() => {
      insertGrant({ sealed_body: null });
    }).toThrow(/NOT NULL/);
    expect(() => {
      db.run(
        `INSERT INTO cashier_offline_grants (tenant_id, branch_id, terminal_id, user_id, sealed_at)
         VALUES ('t', 'b', 'term', 'u', 'x')`,
      );
    }).toThrow(/NOT NULL/);
  });

  it.each([
    ['an empty blob', new Uint8Array([])],
    ['a text body', '{"user_id":"u"}'],
    ['an integer body', 7],
  ])('refuses %s as the sealed body', (_label, body) => {
    expect(() => {
      insertGrant({ sealed_body: body });
    }).toThrow(/CHECK/);
  });

  it.each(['tenant_id', 'branch_id', 'terminal_id', 'user_id', 'sealed_at'])(
    'refuses an empty %s',
    (col) => {
      expect(() => {
        insertGrant({ [col]: '' });
      }).toThrow(/CHECK/);
    },
  );

  it.each(['tenant_id', 'branch_id', 'terminal_id', 'user_id', 'sealed_at'])(
    'refuses a NULL %s',
    (col) => {
      expect(() => {
        insertGrant({ [col]: null });
      }).toThrow(/NOT NULL/);
    },
  );

  it('creates a single-row, sealed clock high-water mark', () => {
    expect(columns('cashier_offline_clock_hwm')).toEqual(['id', 'sealed_body', 'sealed_at']);
    db.run(
      `INSERT INTO cashier_offline_clock_hwm (id, sealed_body, sealed_at) VALUES (1, ?, 'x')`,
      [BODY],
    );
    expect(() => {
      db.run(
        `INSERT INTO cashier_offline_clock_hwm (id, sealed_body, sealed_at) VALUES (2, ?, 'x')`,
        [BODY],
      );
    }).toThrow(/CHECK/);
    expect(() => {
      db.run(
        `INSERT INTO cashier_offline_clock_hwm (id, sealed_body, sealed_at) VALUES (1, ?, 'x')`,
        [BODY],
      );
    }).toThrow(/UNIQUE|PRIMARY/);
    expect(count('cashier_offline_clock_hwm')).toBe(1);
  });

  it.each([
    ['NULL', null],
    ['empty', new Uint8Array([])],
    ['text', '1790000000000'],
  ])('refuses a %s high-water-mark body', (_label, body) => {
    expect(() => {
      db.run(
        `INSERT INTO cashier_offline_clock_hwm (id, sealed_body, sealed_at) VALUES (1, ?, 'x')`,
        [body],
      );
    }).toThrow(/NOT NULL|CHECK/);
  });

  it('ships both tables empty and leaves the PIN and pairing tables as they were', () => {
    expect(count('cashier_offline_grants')).toBe(0);
    expect(count('cashier_offline_clock_hwm')).toBe(0);
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
    expect(columns('terminal_assignment')).toContain('paired_at');
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
    db.exec('DROP TABLE cashier_offline_grants; DROP TABLE cashier_offline_clock_hwm;');
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    expect(columns('cashier_offline_grants')).toContain('sealed_body');
    expect(columns('cashier_offline_clock_hwm')).toContain('sealed_body');
  });
});
