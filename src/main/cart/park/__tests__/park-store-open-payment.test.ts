import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../../db/client.js';
import { bindParkStore, type ParkStore } from '../park-store.js';

/**
 * RT-836 — the open-payment predicate behind the park/resume guard, run against the REAL
 * migrations. A tender line the attempt has already settled is a completed sale, not live
 * payment; only money still in flight may block a resume.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let sqlDb: SqlJsDatabase;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  sqlDb = new SQL.Database();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) sqlDb.run(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  // Partial fixture rows; the predicate under test never follows a foreign key.
  sqlDb.run('PRAGMA foreign_keys = OFF');
});

afterEach(() => {
  sqlDb.close();
});

function handle(): DatabaseHandle {
  const open = <T>(sql: string, params: unknown[], each: (rows: T[]) => T | undefined): unknown => {
    const stmt = sqlDb.prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
      return each(rows);
    } finally {
      stmt.free();
    }
  };
  return {
    prepare: (sql: string) => ({
      get: (...params: unknown[]) => open(sql, params, (rows) => rows[0]),
    }),
  } as unknown as DatabaseHandle;
}

const store = (): ParkStore => bindParkStore(handle());

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

const FILLER_UUID = '00000000-0000-4000-8000-000000000000';

function insert(table: string, overrides: Record<string, string | number | null>): void {
  const stmt = sqlDb.prepare(`PRAGMA table_info(${table})`);
  const columns: ColumnInfo[] = [];
  while (stmt.step()) columns.push(stmt.getAsObject() as unknown as ColumnInfo);
  stmt.free();
  const row: Record<string, string | number | null> = {};
  for (const col of columns) {
    if (col.name in overrides) row[col.name] = overrides[col.name] ?? null;
    else if (col.notnull === 1 && col.dflt_value === null) {
      row[col.name] = /INT|REAL|NUM/i.test(col.type) ? 0 : FILLER_UUID;
    }
  }
  const names = Object.keys(row);
  sqlDb.run(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map((n) => row[n] ?? null),
  );
}

const CART = 'cart-1';
const SESSION = 'session-1';

function cart(state: string): void {
  insert('carts', { cart_id: CART, state, operator_session_id: SESSION });
}

function attempt(state: string): void {
  insert('payment_attempts', {
    payment_attempt_id: 'pa-1',
    envelope_cart_id: CART,
    operator_session_id: SESSION,
    state,
    ...(state === 'failed' ? { failure_reason: 'internal_error' } : {}),
    ...(state === 'force_failed'
      ? { failure_reason: 'manager_force_failed', force_fail_attribution_operator_id: 'mgr-1' }
      : {}),
  });
}

function line(state: string): void {
  insert('payment_tender_lines', {
    tender_line_id: 'tl-1',
    payment_attempt_id: 'pa-1',
    state,
    tender_type: 'cash',
    apply_order: 1,
  });
}

describe('hasOpenPayment / sessionInCheckout (RT-836)', () => {
  it('resumes after a completed sale: settled attempt, applied line, handed-off cart', () => {
    cart('frozen_handed_off');
    attempt('settled');
    line('applied');
    expect(store().hasOpenPayment(CART)).toBe(false);
    expect(store().sessionInCheckout(SESSION)).toBe(false);
  });

  it('still refuses a started attempt, with or without a tender line', () => {
    cart('frozen_handed_off');
    attempt('started');
    expect(store().hasOpenPayment(CART)).toBe(true);
    expect(store().sessionInCheckout(SESSION)).toBe(true);
  });

  it.each(['applying', 'applied', 'reversal_pending'])(
    'still refuses a started attempt holding a %s line',
    (lineState) => {
      cart('frozen_handed_off');
      attempt('started');
      line(lineState);
      expect(store().hasOpenPayment(CART)).toBe(true);
      expect(store().sessionInCheckout(SESSION)).toBe(true);
    },
  );

  // Every terminal attempt state the payment model defines: settled, cancelled, failed, force_failed.
  describe.each(['settled', 'cancelled', 'failed', 'force_failed'])(
    'a %s attempt',
    (attemptState) => {
      it.each(['applied', 'reversed', 'refused'])(
        'is clear when its only line is %s',
        (lineState) => {
          cart(attemptState === 'settled' ? 'frozen_handed_off' : 'cancelled');
          attempt(attemptState);
          line(lineState);
          expect(store().hasOpenPayment(CART)).toBe(false);
        },
      );

      // Money still moving (a pending reversal, a voucher mid-apply) blocks even after the attempt ended.
      it.each(['applying', 'reversal_pending'])('still refuses while a line is %s', (lineState) => {
        cart('frozen_handed_off');
        attempt(attemptState);
        line(lineState);
        expect(store().hasOpenPayment(CART)).toBe(true);
      });
    },
  );

  // A failed / force-failed attempt keeps its applied line; a retry on the same cart then settles.
  it.each(['failed', 'force_failed'])(
    'resumes after a retry settled the cart behind a %s attempt holding an applied line',
    (deadState) => {
      cart('frozen_handed_off');
      attempt(deadState);
      line('applied');
      insert('payment_attempts', {
        payment_attempt_id: 'pa-2',
        envelope_cart_id: CART,
        operator_session_id: SESSION,
        state: 'settled',
      });
      expect(store().hasOpenPayment(CART)).toBe(false);
      expect(store().sessionInCheckout(SESSION)).toBe(false);
    },
  );
});
