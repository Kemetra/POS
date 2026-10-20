import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../db/client.js';
import { createSafePointInputs } from '../safe-point-inputs.js';

/**
 * RT-772 slice 2 — the SQL behind the SafePointGate, run against the REAL
 * migrations (so a wrong table or column name fails here, not silently in the
 * field). Rows are built from `PRAGMA table_info`: every NOT NULL column without
 * a default gets a neutral value, then the test overrides what matters.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
  // The fixtures below are partial rows; the readers under test never follow a foreign key.
  sqlDb.run('PRAGMA foreign_keys = OFF');
});

afterEach(() => {
  sqlDb.close();
});

function handle(): DatabaseHandle {
  return {
    prepare: (sql: string) => ({
      get: (...params: unknown[]): unknown => {
        const stmt = sqlDb.prepare(sql);
        try {
          stmt.bind(params as never);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally {
          stmt.free();
        }
      },
    }),
  } as unknown as DatabaseHandle;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

// UUID-shaped filler: several tables CHECK their id columns are 36-char lowercase UUIDs.
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

const noPrint = { isActive: () => false };
const ext = (n: number): string => `pos-pulse-return:${uid(n)}`;
const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('SafePointInputs on the real schema', () => {
  it('reads every input as clear on an empty database', () => {
    const inputs = createSafePointInputs(handle(), noPrint);
    expect(inputs.hasOpenShift()).toBe(false);
    expect(inputs.hasOpenCart()).toBe(false);
    expect(inputs.hasNonTerminalPayment()).toBe(false);
    expect(inputs.hasReturnInFlight()).toBe(false);
    expect(inputs.isPrintInProgress()).toBe(false);
  });

  it('reports the print counter', () => {
    expect(createSafePointInputs(handle(), { isActive: () => true }).isPrintInProgress()).toBe(
      true,
    );
  });

  describe('open shift', () => {
    it.each([
      { name: 'opened and not yet closed', opens: [1], closes: [], open: true },
      { name: 'opened and then closed', opens: [1], closes: [1], open: false },
      {
        name: 'one shift closed while another is still open',
        opens: [1, 2],
        closes: [1],
        open: true,
      },
    ])('cash-up shift: $name', ({ opens, closes, open }) => {
      for (const n of opens) {
        // One open shift per terminal, so each shift gets its own terminal.
        insert('shift_cashup_opens', {
          shift_id: uid(n),
          currency_code: 'EGP',
          terminal_id: uid(100 + n),
        });
      }
      for (const n of closes) {
        insert('shift_cashup_closes', {
          shift_id: uid(n),
          close_kind: 'normal',
          cash_refund_return_refs_json: '[]',
        });
      }
      expect(createSafePointInputs(handle(), noPrint).hasOpenShift()).toBe(open);
    });

    it('also counts a legacy shifts row that is still open', () => {
      insert('shifts', { id: 'legacy-1', lifecycle_state: 'open', closed_at: null });
      expect(createSafePointInputs(handle(), noPrint).hasOpenShift()).toBe(true);
    });

    it('ignores a closed legacy shift', () => {
      insert('shifts', {
        id: 'legacy-2',
        lifecycle_state: 'closed_normal',
        declared_count: 0,
        closed_at: '2026-10-20T10:00:00.000Z',
      });
      expect(createSafePointInputs(handle(), noPrint).hasOpenShift()).toBe(false);
    });
  });

  describe('open cart', () => {
    const cart = (extra: Record<string, string | number | null> = {}): void => {
      insert('carts', { cart_id: 'cart-1', state: 'editing', parked_at: null, ...extra });
    };
    const line = (extra: Record<string, string | number | null> = {}): void => {
      insert('cart_lines', {
        line_id: 'line-1',
        cart_id: 'cart-1',
        quantity: 1,
        removed_at: null,
        ...extra,
      });
    };

    it('is open when a live cart has an active line', () => {
      cart();
      line();
      expect(createSafePointInputs(handle(), noPrint).hasOpenCart()).toBe(true);
    });

    it('is not open when the cart has no lines, or only removed ones', () => {
      cart();
      expect(createSafePointInputs(handle(), noPrint).hasOpenCart()).toBe(false);
      line({ removed_at: '2026-10-20T10:00:00.000Z' });
      expect(createSafePointInputs(handle(), noPrint).hasOpenCart()).toBe(false);
    });

    it('is not open when the cart was cancelled', () => {
      cart({ state: 'cancelled' });
      line();
      expect(createSafePointInputs(handle(), noPrint).hasOpenCart()).toBe(false);
    });

    it('is not open when the sale is parked (already durably saved)', () => {
      cart({ parked_at: '2026-10-20T10:00:00.000Z' });
      line();
      expect(createSafePointInputs(handle(), noPrint).hasOpenCart()).toBe(false);
    });

    it('is not open once its payment settled', () => {
      cart({ state: 'frozen_handed_off' });
      line();
      insert('payment_attempts', {
        payment_attempt_id: 'pa-1',
        envelope_cart_id: 'cart-1',
        state: 'settled',
      });
      expect(createSafePointInputs(handle(), noPrint).hasOpenCart()).toBe(false);
    });
  });

  describe('payment in flight', () => {
    it('is in flight while an attempt is started, and clear once it is settled', () => {
      insert('payment_attempts', { payment_attempt_id: 'pa-1', state: 'started' });
      expect(createSafePointInputs(handle(), noPrint).hasNonTerminalPayment()).toBe(true);
      sqlDb.run("UPDATE payment_attempts SET state = 'settled' WHERE payment_attempt_id = 'pa-1'");
      expect(createSafePointInputs(handle(), noPrint).hasNonTerminalPayment()).toBe(false);
    });

    // A voucher compensation that cannot reach the authority leaves the parent attempt `failed`
    // while its tender line waits for the deferred resolver: an external request is still due.
    it.each(['applying', 'reversal_pending'])(
      'is in flight while a tender line is %s, even when its attempt already failed',
      (lineState) => {
        insert('payment_attempts', {
          payment_attempt_id: 'pa-2',
          state: 'failed',
          failure_reason: 'split_tender_rollback',
        });
        insert('payment_tender_lines', {
          tender_line_id: 'tl-1',
          payment_attempt_id: 'pa-2',
          state: lineState,
          tender_type: 'internal_voucher',
          apply_order: 1,
        });
        expect(createSafePointInputs(handle(), noPrint).hasNonTerminalPayment()).toBe(true);
      },
    );

    it.each(['applied', 'refused', 'reversed'])(
      'is clear when the only tender lines are %s',
      (lineState) => {
        insert('payment_attempts', { payment_attempt_id: 'pa-3', state: 'settled' });
        insert('payment_tender_lines', {
          tender_line_id: 'tl-2',
          payment_attempt_id: 'pa-3',
          state: lineState,
          tender_type: 'cash',
          apply_order: 1,
        });
        expect(createSafePointInputs(handle(), noPrint).hasNonTerminalPayment()).toBe(false);
      },
    );
  });

  describe('return in flight', () => {
    it.each(['pending', 'unknown'])('is in flight while the return is %s', (state) => {
      insert('return_journal', {
        return_id: `r-${state}`,
        external_id: ext(state === 'pending' ? 1 : 2),
        currency_code: 'EGP',
        state,
      });
      expect(createSafePointInputs(handle(), noPrint).hasReturnInFlight()).toBe(true);
    });

    it('is in flight while confirmed and awaiting its cash payout', () => {
      insert('return_journal', {
        return_id: 'r-confirmed',
        external_id: ext(3),
        currency_code: 'EGP',
        state: 'confirmed',
        return_ref: 'RET-1',
        return_total_minor: 100,
        confirmed_at: '2026-10-20T10:00:00.000Z',
      });
      expect(createSafePointInputs(handle(), noPrint).hasReturnInFlight()).toBe(true);
    });

    it('is clear when every return is refused or paid out', () => {
      insert('return_journal', {
        return_id: 'r-refused',
        external_id: ext(4),
        currency_code: 'EGP',
        state: 'refused',
        refusal_reason: 'sale_not_found',
      });
      expect(createSafePointInputs(handle(), noPrint).hasReturnInFlight()).toBe(false);
    });
  });
});
