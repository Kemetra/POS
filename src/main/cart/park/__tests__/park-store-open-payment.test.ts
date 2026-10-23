import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { bindParkStore, type ParkStore } from '../park-store.js';

/**
 * RT-836 — the open-payment predicate behind the park/resume guard, run against the REAL
 * migrations. A tender line the attempt has already settled is a completed sale, not live
 * payment; only money still in flight may block a resume.
 */

let db: SqlJsDatabase;

beforeAll(initGrantSql);

beforeEach(() => {
  db = freshGrantDb();
  // Partial fixture rows; the predicate under test never follows a foreign key.
  db.run('PRAGMA foreign_keys = OFF');
});

afterEach(() => {
  db.close();
});

const store = (): ParkStore => bindParkStore(handleFor(db));

// UUID-shaped filler: several tables CHECK their id columns are 36-char lowercase UUIDs.
const FILLER_UUID = '00000000-0000-4000-8000-000000000000';

/** Fills every NOT NULL column without a default (from PRAGMA table_info), then applies overrides. */
function insert(table: string, overrides: Record<string, string | number | null>): void {
  const columns = (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []) as [
    number,
    string,
    string,
    number,
    string | null,
  ][];
  const row: Record<string, string | number | null> = { ...overrides };
  const needsFiller = (name: string, notnull: number, dflt: string | null): boolean =>
    !(name in row) && notnull === 1 && dflt === null;
  for (const [, name, type] of columns.filter(([, n, , nn, d]) => needsFiller(n, nn, d))) {
    row[name] = /INT|REAL|NUM/i.test(type) ? 0 : FILLER_UUID;
  }
  const names = Object.keys(row);
  db.run(
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
