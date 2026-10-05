/**
 * RT-224 step 2 (Option B, coordinator decision P3) — the per-sale cashier id.
 *
 * Backend-Core `captureSale` accepts the device bearer plus `operatorUserId`, the
 * `users.id` of the cashier who made the sale. The POS never derives it at send
 * time from whoever is signed in now: payments-confirm writes `selling_user_id`
 * into the sale's own `payment.settled` audit payload at confirm time, and
 * `audit_events` is append-only (0004), so that value is immutable provenance.
 *
 * `createSellingUserIdReader` reads it back for ONE sale:
 *   • the lookup is keyed by the sale's own `envelope_handoff_action_id` (UNIQUE
 *     on `sales`) and scoped to the sale's tenant / branch and the drain's
 *     terminal (RT-221);
 *   • the single matching row must also carry the sale's payment attempt and
 *     selling operator, or it is not this sale's payload;
 *   • no `selling_user_id` key (a manager/admin sale, or a legacy row) → null,
 *     silently: that sale keeps the envelope path;
 *   • 0 rows, more than 1 row, a mismatch, a malformed id or a sale of another
 *     terminal → null, and `onUnresolved` is told ONCE per sale, with a
 *     closed-set reason and the opaque local sale id only (never the user id).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  nn,
  seedSale,
} from './__helpers__/sales-sync-fixture.js';
import { seedSettled } from './__helpers__/settled-audit-fixture.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createSellingUserIdReader, type SellingUserUnresolved } from '../selling-user-id.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const USER_B = '0190a3c4-0000-7000-8000-00000000000b';
const TERMINAL = 'term-1';

function setup() {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const sales = bindSalesRepository(handle);
  const unresolved: SellingUserUnresolved[] = [];
  const read = createSellingUserIdReader({
    db: handle,
    onUnresolved: (info) => unresolved.push(info),
  });
  const sale = (id: string) => nn(sales.readById(id));
  return { db, read, sale, unresolved };
}

describe('RT-224 — selling_user_id is read from the sale’s own payment.settled payload', () => {
  it('returns the cashier id written at confirm time', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toBe(USER_A);
    expect(unresolved).toEqual([]);
    db.close();
  });

  it('reads each sale’s own row, never another sale’s (two cashiers, two sales)', () => {
    const { db, read, sale } = setup();
    seedSale(db, { sale_id: 'sale-a' });
    seedSale(db, { sale_id: 'sale-b' });
    seedSettled(db, {
      sale_id: 'sale-a',
      selling_user_id: USER_A,
      created_at: '2026-06-07T09:00:00.000Z',
    });
    seedSettled(db, {
      sale_id: 'sale-b',
      selling_user_id: USER_B,
      created_at: '2026-06-07T11:00:00.000Z',
    });
    expect(read(sale('sale-a'), TERMINAL)).toBe(USER_A);
    expect(read(sale('sale-b'), TERMINAL)).toBe(USER_B);
    db.close();
  });

  it('a payload with no selling_user_id (manager/admin or legacy sale) → null, silently', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1' });
    expect(read(sale('sale-1'), TERMINAL)).toBeNull();
    expect(unresolved).toEqual([]);
    db.close();
  });

  it('ignores a matching row of another tenant, branch or terminal (RT-221 scope)', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', tenant_id: 'tenant-OTHER', selling_user_id: USER_B });
    seedSettled(db, { sale_id: 'sale-1', branch_id: 'branch-OTHER', selling_user_id: USER_B });
    seedSettled(db, { sale_id: 'sale-1', terminal_id: 'term-OTHER', selling_user_id: USER_B });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toBe(USER_A);
    expect(unresolved).toEqual([]);
    db.close();
  });

  it('a sale of another terminal than the drain’s → null + terminal_mismatch', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1', terminal_id: 'term-OLD' });
    seedSettled(db, { sale_id: 'sale-1', terminal_id: 'term-OLD', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toBeNull();
    expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'terminal_mismatch' }]);
    db.close();
  });

  it('0 matching rows → null + no_settled_event', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-OTHER', selling_user_id: USER_B });
    expect(read(sale('sale-1'), TERMINAL)).toBeNull();
    expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'no_settled_event' }]);
    db.close();
  });

  it('more than 1 matching row → null + multiple_settled_events (never picks one)', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toBeNull();
    expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'multiple_settled_events' }]);
    db.close();
  });

  it('a row for another payment attempt or another operator is not this sale’s → null + settled_event_mismatch', () => {
    const a = setup();
    seedSale(a.db, { sale_id: 'sale-1' });
    seedSettled(a.db, {
      sale_id: 'sale-1',
      payment_attempt_id: 'pa-OTHER',
      selling_user_id: USER_A,
    });
    expect(a.read(a.sale('sale-1'), TERMINAL)).toBeNull();
    expect(a.unresolved).toEqual([{ saleId: 'sale-1', reason: 'settled_event_mismatch' }]);
    a.db.close();

    const b = setup();
    seedSale(b.db, { sale_id: 'sale-1' });
    seedSettled(b.db, {
      sale_id: 'sale-1',
      attribution_operator_id: 'op-OTHER',
      selling_user_id: USER_A,
    });
    expect(b.read(b.sale('sale-1'), TERMINAL)).toBeNull();
    expect(b.unresolved).toEqual([{ saleId: 'sale-1', reason: 'settled_event_mismatch' }]);
    b.db.close();
  });

  it.each([[''], ['not-a-uuid'], [42], [null]])(
    'a malformed selling_user_id (%j) → null + malformed_selling_user_id',
    (bad) => {
      const { db, read, sale, unresolved } = setup();
      seedSale(db, { sale_id: 'sale-1' });
      seedSettled(db, { sale_id: 'sale-1', selling_user_id: bad });
      expect(read(sale('sale-1'), TERMINAL)).toBeNull();
      expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'malformed_selling_user_id' }]);
      db.close();
    },
  );

  it('reports an unresolved sale ONCE, however often it is read', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    for (let i = 0; i < 5; i += 1) expect(read(sale('sale-1'), TERMINAL)).toBeNull();
    expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'no_settled_event' }]);
    db.close();
  });

  it('the unresolved report carries only { saleId, reason } — never a user id', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', payment_attempt_id: 'pa-OTHER', selling_user_id: USER_A });
    read(sale('sale-1'), TERMINAL);
    expect(Object.keys(nn(unresolved[0])).sort()).toEqual(['reason', 'saleId']);
    expect(JSON.stringify(unresolved)).not.toContain(USER_A);
    db.close();
  });
});
