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
 *     reason and goes back to pending or is superseded, attempts never
 *     decrease;
 *   • the repair: a dead letter is superseded by an envelope row of the same
 *     fact and payload that takes its causal position; one active
 *     (non-superseded) row per fact; `superseded` is terminal;
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

interface RepairRow {
  supersedes_seq: number | null;
  origin_seq: number | null;
  auth_path: string;
  idempotency_key: string;
  request_body: string;
}

const REPAIR_ROW: RepairRow = {
  supersedes_seq: 1,
  origin_seq: 1,
  auth_path: 'envelope',
  idempotency_key: `pos-pulse-shift-open:${S1}:repair-1`,
  request_body: JSON.stringify({ shiftId: S1 }),
};

const T1 = '2026-10-05T09:00:00.000Z';

/** An outbox row for the open of S1 that supersedes another (default: seq 1). */
function repair(row: Partial<RepairRow> = {}): void {
  const r = { ...REPAIR_ROW, ...row };
  db.run(
    `INSERT INTO shift_sync_outbox (fact_kind, shift_id, movement_id, tenant_id, branch_id,
       terminal_id, auth_path, idempotency_key, request_body, enqueued_at, supersedes_seq,
       origin_seq)
     VALUES ('open', ?, NULL, 't', 'b', 'term-1', ?, ?, ?, ?, ?, ?)`,
    [S1, r.auth_path, r.idempotency_key, r.request_body, T1, r.supersedes_seq, r.origin_seq],
  );
}

function deadLetter(of: { seq: number }): void {
  db.run(
    `UPDATE shift_sync_state SET sync_status = 'dead_letter', dead_letter_reason = 'refused'
     WHERE seq = ?`,
    [of.seq],
  );
}

function stateOf(of: { seq: number }): Record<string, unknown> {
  const res = db.exec(`SELECT * FROM shift_sync_state WHERE seq = ${String(of.seq)}`)[0];
  if (res === undefined) throw new Error(`no state row ${String(of.seq)}`);
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

function count(of: { table: string }): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${of.table}`)[0]?.values[0]?.[0] ?? -1);
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
    expect([
      count({ table: 'shift_cashup_opens' }),
      count({ table: 'shift_cashup_movements' }),
    ]).toEqual([1, 1]);
    expect(count({ table: 'shift_cashup_closes' })).toBe(1);
  });

  it.each<{ name: string; row: Partial<OpenRow> }>([
    { name: 'an upper-case shift id', row: { shift_id: S1.toUpperCase() } },
    { name: 'a non-UUID shift id', row: { shift_id: 'shift-1' } },
    { name: 'an upper-case opening user', row: { opening_user_id: USER.toUpperCase() } },
    { name: 'a REAL float', row: { opening_float_minor: 1.5 } },
    { name: 'a negative float', row: { opening_float_minor: -1 } },
  ])('refuses an open with $name', ({ row }) => {
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
    expect(count({ table: 'shift_cashup_opens' })).toBe(3);
  });

  it.each<{ name: string; row: Partial<MovementRow>; error: RegExp }>([
    { name: 'a zero amount', row: { amount_minor: 0 }, error: /CHECK constraint failed/ },
    { name: 'a REAL amount', row: { amount_minor: 2.5 }, error: /CHECK constraint failed/ },
    { name: 'an unknown kind', row: { kind: 'refund' }, error: /CHECK constraint failed/ },
    { name: 'an empty note', row: { note: '' }, error: /CHECK constraint failed/ },
    {
      name: 'a 201-character note',
      row: { note: 'x'.repeat(201) },
      error: /CHECK constraint failed/,
    },
    { name: 'an unknown shift', row: { shift_id: S2 }, error: /FOREIGN KEY constraint failed/ },
  ])('refuses a movement with $name', ({ row, error }) => {
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

  it.each<{ name: string; row: Partial<CloseRow>; error: RegExp }>([
    {
      name: 'a wrong expected cash',
      row: { expected_cash_minor: 60_001, variance_minor: -501 },
      error: /CHECK/,
    },
    { name: 'a wrong variance', row: { variance_minor: -499 }, error: /CHECK/ },
    {
      name: 'a negative counted cash',
      row: { counted_cash_minor: -1, variance_minor: -60_001 },
      error: /CHECK/,
    },
    { name: 'a forced close without a reason', row: { close_kind: 'forced' }, error: /CHECK/ },
    { name: 'a normal close with a reason', row: { forced_reason: 'why' }, error: /CHECK/ },
    { name: 'a refs value that is not an array', row: { refs_json: '{}' }, error: /CHECK/ },
    {
      name: 'a float other than the open',
      row: { opening_float_minor: 40_000, expected_cash_minor: 50_000, variance_minor: 9_500 },
      error: /float or movement totals/,
    },
    {
      name: 'a pay-out total with no movement',
      row: { pay_out_total_minor: 100, expected_cash_minor: 59_900, variance_minor: -400 },
      error: /float or movement totals/,
    },
  ])('refuses a close with $name', ({ row, error }) => {
    open();
    expect(() => {
      close(row);
    }).toThrow(error);
  });

  it('accepts a forced close with a reason', () => {
    open();
    close({ close_kind: 'forced', forced_reason: 'Cashier left' });
    expect(count({ table: 'shift_cashup_closes' })).toBe(1);
  });

  it('closes a shift once', () => {
    open();
    close();
    expect(() => {
      close();
    }).toThrow(/UNIQUE constraint failed/);
  });

  it.each([
    { table: 'shift_cashup_opens', sql: 'UPDATE shift_cashup_opens SET opened_at = opened_at' },
    { table: 'shift_cashup_opens', sql: 'DELETE FROM shift_cashup_opens' },
    { table: 'shift_cashup_movements', sql: 'UPDATE shift_cashup_movements SET note = NULL' },
    { table: 'shift_cashup_movements', sql: 'DELETE FROM shift_cashup_movements' },
    { table: 'shift_cashup_closes', sql: 'UPDATE shift_cashup_closes SET sale_count = 4' },
    { table: 'shift_cashup_closes', sql: 'DELETE FROM shift_cashup_closes' },
  ])('$table is append-only ($sql)', ({ table, sql }) => {
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

  it.each<{ name: string; row: Partial<OutboxRow>; error: RegExp }>([
    {
      name: 'an envelope body carrying operatorUserId',
      row: { auth_path: 'envelope' },
      error: /CHECK/,
    },
    {
      name: 'a device body without operatorUserId',
      row: { request_body: JSON.stringify({ shiftId: S1 }) },
      error: /CHECK/,
    },
    {
      name: 'an open body for another shift',
      row: { request_body: JSON.stringify({ shiftId: S2, operatorUserId: USER }) },
      error: /CHECK/,
    },
    { name: 'a short idempotency key', row: { idempotency_key: 'short' }, error: /CHECK/ },
    {
      name: 'an idempotency key with a space',
      row: { idempotency_key: 'pos-pulse shift open 1' },
      error: /CHECK/,
    },
    {
      name: 'a device body whose operatorUserId is JSON null',
      row: { request_body: JSON.stringify({ shiftId: S1, operatorUserId: null }) },
      error: /CHECK/,
    },
    {
      name: 'an envelope body whose operatorUserId is JSON null',
      row: {
        auth_path: 'envelope',
        request_body: JSON.stringify({ shiftId: S1, operatorUserId: null }),
      },
      error: /CHECK/,
    },
    { name: 'a body that is not JSON', row: { request_body: 'nope' }, error: /CHECK/ },
    { name: 'an unknown fact kind', row: { fact_kind: 'reopen' }, error: /CHECK/ },
    {
      name: 'another terminal than the shift',
      row: { terminal_id: 'term-2' },
      error: /no such fact/,
    },
  ])('refuses $name', ({ row, error }) => {
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
    { sql: 'UPDATE shift_sync_outbox SET request_body = request_body' },
    { sql: 'DELETE FROM shift_sync_outbox' },
  ])('the outbox is immutable ($sql)', ({ sql }) => {
    open();
    enqueue();
    expect(() => {
      db.run(sql);
    }).toThrow(/shift_sync_outbox is append-only/);
  });

  it.each([
    { name: 'synced', set: "sync_status = 'synced', synced_at = 't1'" },
    {
      name: 'dead_letter',
      set: "sync_status = 'dead_letter', dead_letter_reason = 'shift_not_found'",
    },
    {
      name: 'pending, retried',
      set: "attempt_count = 1, next_retry_at = 't1', last_error_category = 'transient'",
    },
  ])('allows pending → $name', ({ set }) => {
    open();
    enqueue();
    db.run(`UPDATE shift_sync_state SET ${set}`);
    expect(count({ table: 'shift_sync_state' })).toBe(1);
  });

  it.each<{ name: string; set: string; error: RegExp }>([
    { name: 'synced without synced_at', set: "sync_status = 'synced'", error: /CHECK/ },
    { name: 'a dead letter without a reason', set: "sync_status = 'dead_letter'", error: /CHECK/ },
    {
      name: 'a reason that is not a code',
      set: "sync_status = 'dead_letter', dead_letter_reason = 'Shift Gone!'",
      error: /CHECK/,
    },
    {
      name: 'a decreasing attempt count',
      set: 'attempt_count = -1',
      error: /CHECK|illegal transition/,
    },
    { name: 'a changed created_at', set: "created_at = 't9'", error: /illegal transition/ },
  ])('refuses $name', ({ set, error }) => {
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

describe('0043 — repairing a dead letter (supersede)', () => {
  beforeEach(() => {
    open();
    enqueue();
  });

  it('an envelope row supersedes a dead letter in the same statement', () => {
    deadLetter({ seq: 1 });
    repair();
    expect(stateOf({ seq: 1 })).toMatchObject({
      sync_status: 'superseded',
      superseded_by_seq: 2,
      resolved_at: T1,
      updated_at: T1,
      dead_letter_reason: 'refused',
    });
    expect(stateOf({ seq: 2 })).toMatchObject({ sync_status: 'pending', attempt_count: 0 });
  });

  it.each<{ name: string; deadLetterFirst: boolean; row: Partial<RepairRow>; error: RegExp }>([
    {
      name: 'a row that is not dead-lettered',
      deadLetterFirst: false,
      row: {},
      error: /a repair supersedes/,
    },
    {
      name: 'a different payload',
      deadLetterFirst: true,
      row: { request_body: JSON.stringify({ shiftId: S1, extra: true }) },
      error: /a repair supersedes/,
    },
    {
      name: 'another causal position',
      deadLetterFirst: true,
      row: { origin_seq: 2 },
      error: /a repair supersedes|FOREIGN KEY/,
    },
    {
      name: 'a lineage without a causal position',
      deadLetterFirst: true,
      row: { origin_seq: null },
      error: /a repair supersedes|CHECK/,
    },
    {
      name: 'a device-path repair',
      deadLetterFirst: true,
      row: {
        auth_path: 'device',
        request_body: JSON.stringify({ shiftId: S1, operatorUserId: USER }),
      },
      error: /a repair supersedes|CHECK/,
    },
    {
      name: 'an envelope repair carrying operatorUserId',
      deadLetterFirst: true,
      row: { request_body: JSON.stringify({ shiftId: S1, operatorUserId: USER }) },
      error: /a repair supersedes|CHECK/,
    },
    {
      name: 'an unknown row',
      deadLetterFirst: false,
      row: { supersedes_seq: 9, origin_seq: 9 },
      error: /a repair supersedes/,
    },
  ])('refuses a repair of $name', ({ deadLetterFirst, row, error }) => {
    if (deadLetterFirst) deadLetter({ seq: 1 });
    expect(() => {
      repair(row);
    }).toThrow(error);
    expect(count({ table: 'shift_sync_outbox' })).toBe(1);
  });

  it('supersedes a row once; a repair of the repair keeps the causal position', () => {
    deadLetter({ seq: 1 });
    repair();
    expect(() => {
      repair({ idempotency_key: `pos-pulse-shift-open:${S1}:repair-1b` });
    }).toThrow(/a repair supersedes|UNIQUE/);
    deadLetter({ seq: 2 });
    expect(() => {
      repair({
        supersedes_seq: 2,
        origin_seq: 2,
        idempotency_key: `pos-pulse-shift-open:${S1}:repair-2`,
      });
    }).toThrow(/a repair supersedes/);
    repair({
      supersedes_seq: 2,
      origin_seq: 1,
      idempotency_key: `pos-pulse-shift-open:${S1}:repair-2`,
    });
    const active = db.exec(
      `SELECT o.seq FROM shift_sync_outbox o JOIN shift_sync_state s ON s.seq = o.seq
       WHERE o.fact_kind = 'open' AND o.shift_id = '${S1}' AND s.sync_status <> 'superseded'`,
    )[0]?.values;
    expect(active).toEqual([[3]]);
  });

  it.each<{ name: string; set: string; deadLetterFirst: boolean }>([
    {
      name: 'pending → superseded',
      set: "sync_status = 'superseded', superseded_by_seq = 1, resolved_at = 't', dead_letter_reason = 'x'",
      deadLetterFirst: false,
    },
    {
      name: 'dead_letter → superseded with no successor',
      set: "sync_status = 'superseded', superseded_by_seq = 1, resolved_at = 't'",
      deadLetterFirst: true,
    },
  ])('refuses $name', ({ set, deadLetterFirst }) => {
    if (deadLetterFirst) deadLetter({ seq: 1 });
    expect(() => {
      db.run(`UPDATE shift_sync_state SET ${set} WHERE seq = 1`);
    }).toThrow(/illegal transition/);
  });

  it.each<{ name: string; set: string; error: RegExp }>([
    {
      name: 'superseded without a successor',
      set: "sync_status = 'superseded', resolved_at = 't'",
      error: /CHECK|illegal transition/,
    },
    {
      name: 'superseded without resolved_at',
      set: "sync_status = 'superseded', superseded_by_seq = 1",
      error: /CHECK|illegal transition/,
    },
    {
      name: 'a resolved_at on a live row',
      set: "resolved_at = 't'",
      error: /CHECK/,
    },
  ])('refuses $name', ({ set, error }) => {
    expect(() => {
      db.run(`UPDATE shift_sync_state SET ${set} WHERE seq = 1`);
    }).toThrow(error);
  });

  it('keeps superseded terminal', () => {
    deadLetter({ seq: 1 });
    repair();
    expect(() => {
      db.run(
        `UPDATE shift_sync_state SET sync_status = 'pending', superseded_by_seq = NULL,
           resolved_at = NULL, dead_letter_reason = NULL WHERE seq = 1`,
      );
    }).toThrow(/illegal transition/);
    expect(() => {
      db.run("UPDATE shift_sync_state SET updated_at = 'later' WHERE seq = 1");
    }).toThrow(/illegal transition/);
  });

  it('indexes the unsettled state rows only (the drain head lookup)', () => {
    const sql = db.exec(
      "SELECT sql FROM sqlite_master WHERE name = 'idx_shift_sync_state_unsettled'",
    )[0]?.values[0]?.[0];
    expect(String(sql)).toMatch(/WHERE sync_status IN \('pending', 'dead_letter'\)/);
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
    expect(count({ table: 'shift_sync_state' })).toBe(1);
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
