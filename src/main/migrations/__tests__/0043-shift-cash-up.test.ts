/**
 * RT-17 slice 3 — migration-shape test for `0043_shift_cash_up` ([GATED],
 * Jira RT-17 comment 10920).
 *
 * Runs the full migration stack on sql.js and asserts the storage backstops:
 *   • the facts (open / movement / close) are append-only, store money as
 *     integer minor units and ids as lower-case UUIDs;
 *   • at most one open shift per terminal; movements only on an open shift;
 *   • the close arithmetic, and the close's float and movement totals, hold;
 *   • the outbox stores exact bytes immutably, one row per fact, in the fact's
 *     scope, with `operatorUserId` exactly on the device path and never a
 *     device-path forced close; each outbox row gets a pending state row;
 *   • the state machine: `synced` is terminal, a dead letter carries its
 *     reason and only goes back to pending, attempts never decrease;
 *   • through the real runner it applies exactly once.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations, type MigrationsDb } from '../../db/migrate.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = '0043_shift_cash_up';
const SQL_TEXT = readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'migrations', `${MIGRATION}.sql`),
  'utf8',
);

const S1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';
const S2 = '0192f5a2-3b4c-7d8e-9f01-000000000002';
const M1 = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const USER = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const T0 = '2026-10-05T08:00:00.000Z';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
});

afterEach(() => {
  db.close();
});

interface OpenRow {
  shift_id: string;
  terminal_id: string;
  opening_user_id: string;
  opening_float_minor: number;
}

const OPEN_ROW: OpenRow = {
  shift_id: S1,
  terminal_id: 'term-1',
  opening_user_id: USER,
  opening_float_minor: 50_000,
};

function open(row: Partial<OpenRow> = {}): void {
  const r = { ...OPEN_ROW, ...row };
  db.run(
    `INSERT INTO shift_cashup_opens (shift_id, tenant_id, branch_id, terminal_id,
       opening_user_id, currency_code, opening_float_minor, opened_at, created_at)
     VALUES (?, 't', 'b', ?, ?, 'EGP', ?, ?, ?)`,
    [r.shift_id, r.terminal_id, r.opening_user_id, r.opening_float_minor, T0, T0],
  );
}

interface MovementRow {
  movement_id: string;
  shift_id: string;
  kind: string;
  amount_minor: number;
  note: string | null;
}

const MOVEMENT_ROW: MovementRow = {
  movement_id: M1,
  shift_id: S1,
  kind: 'pay_out',
  amount_minor: 12_000,
  note: null,
};

function move(row: Partial<MovementRow> = {}): void {
  const r = { ...MOVEMENT_ROW, ...row };
  db.run(
    `INSERT INTO shift_cashup_movements (movement_id, shift_id, kind, amount_minor,
       reason_code, note, occurred_at, operator_user_id, created_at)
     VALUES (?, ?, ?, ?, 'petty_expense', ?, ?, ?, ?)`,
    [r.movement_id, r.shift_id, r.kind, r.amount_minor, r.note, T0, USER, T0],
  );
}

interface CloseRow {
  shift_id: string;
  close_kind: string;
  forced_reason: string | null;
  opening_float_minor: number;
  pay_out_total_minor: number;
  expected_cash_minor: number;
  counted_cash_minor: number;
  variance_minor: number;
  refs_json: string;
}

/** Float 500.00 + sales 100.00 − refunds 0 + in 0 − out 0 = 600.00; counted 595.00. */
const CLOSE_ROW: CloseRow = {
  shift_id: S1,
  close_kind: 'normal',
  forced_reason: null,
  opening_float_minor: 50_000,
  pay_out_total_minor: 0,
  expected_cash_minor: 60_000,
  counted_cash_minor: 59_500,
  variance_minor: -500,
  refs_json: '[]',
};

function close(row: Partial<CloseRow> = {}): void {
  const r = { ...CLOSE_ROW, ...row };
  db.run(
    `INSERT INTO shift_cashup_closes (shift_id, closed_at, closing_user_id, close_kind,
       forced_reason, opening_float_minor, cash_sales_total_minor, cash_refunds_total_minor,
       pay_in_total_minor, pay_out_total_minor, expected_cash_minor, counted_cash_minor,
       variance_minor, sale_count, cash_refund_return_refs_json, variance_approved_by_user_id,
       created_at)
     VALUES (?, ?, ?, ?, ?, ?, 10000, 0, 0, ?, ?, ?, ?, 3, ?, NULL, ?)`,
    [
      r.shift_id,
      T0,
      USER,
      r.close_kind,
      r.forced_reason,
      r.opening_float_minor,
      r.pay_out_total_minor,
      r.expected_cash_minor,
      r.counted_cash_minor,
      r.variance_minor,
      r.refs_json,
      T0,
    ],
  );
}

interface OutboxRow {
  fact_kind: string;
  shift_id: string;
  movement_id: string | null;
  terminal_id: string;
  auth_path: string;
  idempotency_key: string;
  request_body: string;
}

const OUTBOX_ROW: OutboxRow = {
  fact_kind: 'open',
  shift_id: S1,
  movement_id: null,
  terminal_id: 'term-1',
  auth_path: 'device',
  idempotency_key: `pos-pulse-shift-open:${S1}`,
  request_body: JSON.stringify({ shiftId: S1, operatorUserId: USER }),
};

function enqueue(row: Partial<OutboxRow> = {}): void {
  const r = { ...OUTBOX_ROW, ...row };
  db.run(
    `INSERT INTO shift_sync_outbox (fact_kind, shift_id, movement_id, tenant_id, branch_id,
       terminal_id, auth_path, idempotency_key, request_body, enqueued_at)
     VALUES (?, ?, ?, 't', 'b', ?, ?, ?, ?, ?)`,
    [
      r.fact_kind,
      r.shift_id,
      r.movement_id,
      r.terminal_id,
      r.auth_path,
      r.idempotency_key,
      r.request_body,
      T0,
    ],
  );
}

function count(table: string): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? -1);
}

function state(): Record<string, unknown> {
  const res = db.exec('SELECT * FROM shift_sync_state ORDER BY seq LIMIT 1')[0];
  if (res === undefined) throw new Error('no state row');
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

describe('0043 — the facts', () => {
  it('records an open, a movement and a matching close', () => {
    open();
    move();
    close({ pay_out_total_minor: 12_000, expected_cash_minor: 48_000, variance_minor: 11_500 });
    expect([count('shift_cashup_opens'), count('shift_cashup_movements')]).toEqual([1, 1]);
    expect(count('shift_cashup_closes')).toBe(1);
  });

  it.each<[string, Partial<OpenRow>]>([
    ['an upper-case shift id', { shift_id: S1.toUpperCase() }],
    ['a non-UUID shift id', { shift_id: 'shift-1' }],
    ['an upper-case opening user', { opening_user_id: USER.toUpperCase() }],
    ['a REAL float', { opening_float_minor: 1.5 }],
    ['a negative float', { opening_float_minor: -1 }],
  ])('refuses an open with %s', (_name, row) => {
    expect(() => {
      open(row);
    }).toThrow(/CHECK constraint failed/);
  });

  it('allows at most one open shift per terminal', () => {
    open();
    expect(() => {
      open({ shift_id: S2 });
    }).toThrow(/already has an open shift/);
    open({ shift_id: S2, terminal_id: 'term-2' });
    close();
    open({ shift_id: '0192f5a2-3b4c-7d8e-9f01-000000000003' });
    expect(count('shift_cashup_opens')).toBe(3);
  });

  it.each<[string, Partial<MovementRow>, RegExp]>([
    ['a zero amount', { amount_minor: 0 }, /CHECK constraint failed/],
    ['a REAL amount', { amount_minor: 2.5 }, /CHECK constraint failed/],
    ['an unknown kind', { kind: 'refund' }, /CHECK constraint failed/],
    ['an empty note', { note: '' }, /CHECK constraint failed/],
    ['a 201-character note', { note: 'x'.repeat(201) }, /CHECK constraint failed/],
    ['an unknown shift', { shift_id: S2 }, /FOREIGN KEY constraint failed/],
  ])('refuses a movement with %s', (_name, row, error) => {
    open();
    expect(() => {
      move(row);
    }).toThrow(error);
  });

  it('refuses a movement on a closed shift', () => {
    open();
    close();
    expect(() => {
      move();
    }).toThrow(/the shift is closed/);
  });

  it.each<[string, Partial<CloseRow>, RegExp]>([
    ['a wrong expected cash', { expected_cash_minor: 60_001, variance_minor: -501 }, /CHECK/],
    ['a wrong variance', { variance_minor: -499 }, /CHECK/],
    ['a negative counted cash', { counted_cash_minor: -1, variance_minor: -60_001 }, /CHECK/],
    ['a forced close without a reason', { close_kind: 'forced' }, /CHECK/],
    ['a normal close with a reason', { forced_reason: 'why' }, /CHECK/],
    ['a refs value that is not an array', { refs_json: '{}' }, /CHECK/],
    [
      'a float other than the open',
      { opening_float_minor: 40_000, expected_cash_minor: 50_000, variance_minor: 9_500 },
      /float or movement totals/,
    ],
    [
      'a pay-out total with no movement',
      { pay_out_total_minor: 100, expected_cash_minor: 59_900, variance_minor: -400 },
      /float or movement totals/,
    ],
  ])('refuses a close with %s', (_name, row, error) => {
    open();
    expect(() => {
      close(row);
    }).toThrow(error);
  });

  it('accepts a forced close with a reason', () => {
    open();
    close({ close_kind: 'forced', forced_reason: 'Cashier left' });
    expect(count('shift_cashup_closes')).toBe(1);
  });

  it('closes a shift once', () => {
    open();
    close();
    expect(() => {
      close();
    }).toThrow(/UNIQUE constraint failed/);
  });

  it.each([
    ['shift_cashup_opens', 'UPDATE shift_cashup_opens SET opened_at = opened_at'],
    ['shift_cashup_opens', 'DELETE FROM shift_cashup_opens'],
    ['shift_cashup_movements', 'UPDATE shift_cashup_movements SET note = NULL'],
    ['shift_cashup_movements', 'DELETE FROM shift_cashup_movements'],
    ['shift_cashup_closes', 'UPDATE shift_cashup_closes SET sale_count = 4'],
    ['shift_cashup_closes', 'DELETE FROM shift_cashup_closes'],
  ])('%s is append-only (%s)', (table, sql) => {
    open();
    move();
    close({ pay_out_total_minor: 12_000, expected_cash_minor: 48_000, variance_minor: 11_500 });
    expect(() => {
      db.run(sql);
    }).toThrow(new RegExp(`${table} is append-only`));
  });
});

describe('0043 — the outbox and its state', () => {
  it('creates a pending, unattempted state row with every outbox row', () => {
    open();
    enqueue();
    expect(state()).toMatchObject({ seq: 1, sync_status: 'pending', attempt_count: 0 });
  });

  it.each<[string, Partial<OutboxRow>, RegExp]>([
    ['an envelope body carrying operatorUserId', { auth_path: 'envelope' }, /CHECK/],
    [
      'a device body without operatorUserId',
      { request_body: JSON.stringify({ shiftId: S1 }) },
      /CHECK/,
    ],
    [
      'an open body for another shift',
      { request_body: JSON.stringify({ shiftId: S2, operatorUserId: USER }) },
      /CHECK/,
    ],
    ['a short idempotency key', { idempotency_key: 'short' }, /CHECK/],
    ['an idempotency key with a space', { idempotency_key: 'pos-pulse shift open 1' }, /CHECK/],
    ['a body that is not JSON', { request_body: 'nope' }, /CHECK/],
    ['an unknown fact kind', { fact_kind: 'reopen' }, /CHECK/],
    ['another terminal than the shift', { terminal_id: 'term-2' }, /no such fact/],
  ])('refuses %s', (_name, row, error) => {
    open();
    expect(() => {
      enqueue(row);
    }).toThrow(error);
  });

  it('refuses a close row before the close fact, and a movement of another shift', () => {
    open();
    expect(() => {
      enqueue({ fact_kind: 'close', idempotency_key: `pos-pulse-shift-close:${S1}` });
    }).toThrow(/no such fact/);
    open({ shift_id: S2, terminal_id: 'term-2' });
    move({ shift_id: S2 });
    expect(() => {
      enqueue({
        fact_kind: 'movement',
        movement_id: M1,
        idempotency_key: `pos-pulse-shift-movement:${M1}`,
        request_body: JSON.stringify({ movementId: M1, operatorUserId: USER }),
      });
    }).toThrow(/no such fact/);
  });

  it('refuses a device-path forced close', () => {
    open();
    close({ close_kind: 'forced', forced_reason: 'Cashier left' });
    expect(() => {
      enqueue({
        fact_kind: 'close',
        idempotency_key: `pos-pulse-shift-close:${S1}`,
        request_body: JSON.stringify({ closeKind: 'forced', operatorUserId: USER }),
      });
    }).toThrow(/CHECK/);
  });

  it('holds one row per fact', () => {
    open();
    enqueue();
    expect(() => {
      enqueue({ idempotency_key: `pos-pulse-shift-open-again:${S1}` });
    }).toThrow(/UNIQUE constraint failed/);
  });

  it.each([
    'UPDATE shift_sync_outbox SET request_body = request_body',
    'DELETE FROM shift_sync_outbox',
  ])('the outbox is immutable (%s)', (sql) => {
    open();
    enqueue();
    expect(() => {
      db.run(sql);
    }).toThrow(/shift_sync_outbox is append-only/);
  });

  it.each([
    ['synced', "sync_status = 'synced', synced_at = 't1'"],
    ['dead_letter', "sync_status = 'dead_letter', dead_letter_reason = 'shift_not_found'"],
    [
      'pending, retried',
      "attempt_count = 1, next_retry_at = 't1', last_error_category = 'transient'",
    ],
  ])('allows pending → %s', (_name, set) => {
    open();
    enqueue();
    db.run(`UPDATE shift_sync_state SET ${set}`);
    expect(count('shift_sync_state')).toBe(1);
  });

  it.each<[string, string, RegExp]>([
    ['synced without synced_at', "sync_status = 'synced'", /CHECK/],
    ['a dead letter without a reason', "sync_status = 'dead_letter'", /CHECK/],
    [
      'a reason that is not a code',
      "sync_status = 'dead_letter', dead_letter_reason = 'Shift Gone!'",
      /CHECK/,
    ],
    ['a decreasing attempt count', 'attempt_count = -1', /CHECK|illegal transition/],
    ['a changed created_at', "created_at = 't9'", /illegal transition/],
  ])('refuses %s', (_name, set, error) => {
    open();
    enqueue();
    expect(() => {
      db.run(`UPDATE shift_sync_state SET ${set}`);
    }).toThrow(error);
  });

  it('keeps synced terminal and lets a dead letter go back to pending only', () => {
    open();
    enqueue();
    db.run("UPDATE shift_sync_state SET sync_status = 'dead_letter', dead_letter_reason = 'x'");
    expect(() => {
      db.run(
        "UPDATE shift_sync_state SET sync_status = 'synced', dead_letter_reason = NULL, synced_at = 't'",
      );
    }).toThrow(/illegal transition/);
    db.run("UPDATE shift_sync_state SET sync_status = 'pending', dead_letter_reason = NULL");
    db.run("UPDATE shift_sync_state SET sync_status = 'synced', synced_at = 't'");
    expect(() => {
      db.run("UPDATE shift_sync_state SET sync_status = 'pending', synced_at = NULL");
    }).toThrow(/illegal transition/);
    expect(() => {
      db.run('DELETE FROM shift_sync_state');
    }).toThrow(/DELETE is denied/);
  });

  it('refuses a state row inserted as anything but pending', () => {
    open();
    enqueue();
    expect(() => {
      db.run(
        "INSERT INTO shift_sync_state (seq, sync_status, synced_at, created_at, updated_at) VALUES (2, 'synced', 't', 't', 't')",
      );
    }).toThrow(/starts pending/);
  });
});

describe('0043 — the runner', () => {
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
    db.exec(
      'DROP TABLE shift_sync_state; DROP TABLE shift_sync_outbox; DROP TABLE shift_cashup_closes;' +
        ' DROP TABLE shift_cashup_movements; DROP TABLE shift_cashup_opens;',
    );
    const files = [{ name: MIGRATION, sql: SQL_TEXT }];
    runMigrations({ db: runnerDb, files });
    runMigrations({ db: runnerDb, files });
    expect(applied).toEqual([MIGRATION]);
    open();
    enqueue();
    expect(count('shift_sync_state')).toBe(1);
  });

  it('leaves the 004-era shifts table untouched', () => {
    const cols = db.exec('PRAGMA table_info(shifts)')[0]?.values.map((v) => v[1]);
    expect(cols).toEqual([
      'id',
      'tenant_id',
      'branch_id',
      'originating_terminal_id',
      'opening_operator_id',
      'lifecycle_state',
      'declared_count',
      'opened_at',
      'closed_at',
    ]);
  });
});
