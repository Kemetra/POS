/**
 * RT-224 step 2 (Option B, coordinator decision P3) — the per-sale cashier id.
 *
 * Backend-Core `captureSale` accepts the device bearer plus `operatorUserId`, the
 * `users.id` of the cashier who made the sale. The POS never derives it at send
 * time from whoever is signed in now: payments-confirm writes `selling_user_id`
 * into the sale's own `payment.settled` audit payload at confirm time, and
 * `audit_events` is append-only (0004), so that value is immutable provenance.
 *
 * `createSellingUserIdResolver` reads it back per sale:
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
 *
 * Codex P2 (#547): `audit_events` has no index on the category or the payload, so
 * the lookup must not scan it once per sale. All the sales of a batch not seen
 * before are resolved in ONE single-pass query; results are memoized per sale
 * until `forget` (the sale left the queue).
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
import type { Database as SqlJsDatabase } from 'sql.js';

import type { DatabaseHandle } from '../../db/client.js';
import { bindSalesRepository, type SaleRow } from '../../sales/repositories/sales.repository.js';
import { createSellingUserIdResolver, type SellingUserUnresolved } from '../selling-user-id.js';

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
  const resolver = createSellingUserIdResolver({
    db: handle,
    onUnresolved: (info) => unresolved.push(info),
  });
  const read = (one: SaleRow, terminalId: string): string | null =>
    resolver.resolve([one], terminalId).get(one.sale_id) ?? null;
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

type Executable = Record<'all' | 'get' | 'run', (...params: unknown[]) => unknown>;

/** A handle that records every EXECUTION of a statement against `audit_events`. */
function countingHandle(db: SqlJsDatabase): { handle: DatabaseHandle; auditSql: string[] } {
  const inner = handleFor(db);
  const auditSql: string[] = [];
  const handle: DatabaseHandle = {
    ...inner,
    prepare: (sql: string) => {
      const stmt = inner.prepare(sql) as Executable;
      if (!sql.includes('audit_events')) return stmt;
      const counted =
        (fn: Executable['all']) =>
        (...params: unknown[]) => {
          auditSql.push(sql);
          return fn(...params);
        };
      return { all: counted(stmt.all), get: counted(stmt.get), run: counted(stmt.run) };
    },
  };
  return { handle, auditSql };
}

/** Seed `n` unrelated audit rows (the till's other history) in one transaction. */
function seedNoise(db: SqlJsDatabase, n: number): void {
  db.exec('BEGIN');
  const stmt = db.prepare(
    `INSERT INTO audit_events
       (event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id, session_id,
        shift_id, action_category, created_at, approving_supervisor_id, payload)
     VALUES (?, 'tenant-1', 'branch-1', 'term-1', 'op-1', 'sess-1', NULL, ?, '2026-06-07T09:00:00.000Z', NULL, ?)`,
  );
  for (let i = 0; i < n; i += 1) {
    stmt.run([
      `noise-${String(i)}`,
      i % 2 === 0 ? 'tender.applied' : 'cart.line_added',
      JSON.stringify({ i, handoff_action_id: `handoff-noise-${String(i)}` }),
    ]);
  }
  stmt.free();
  db.exec('COMMIT');
}

describe('RT-224 (Codex P2) — one audit_events pass per batch, memoized, never per sale', () => {
  const SALES = 500;

  function backlog() {
    const db = freshSalesSyncDb();
    seedNoise(db, 20_000);
    for (let i = 0; i < SALES; i += 1) {
      const id = `sale-${String(i)}`;
      seedSale(db, { sale_id: id });
      seedSettled(db, { sale_id: id, ...(i % 5 === 0 ? {} : { selling_user_id: USER_A }) });
    }
    const counting = countingHandle(db);
    const sales = bindSalesRepository(handleFor(db));
    const rows = Array.from({ length: SALES }, (_, i) => nn(sales.readById(`sale-${String(i)}`)));
    const resolver = createSellingUserIdResolver({ db: counting.handle });
    return { db, rows, resolver, auditSql: counting.auditSql };
  }

  it('500 queued sales over a 20k-row audit table: ONE query resolves them all', () => {
    const { db, rows, resolver, auditSql } = backlog();
    const ids = resolver.resolve(rows, TERMINAL);
    expect(auditSql).toHaveLength(1);
    expect(ids.size).toBe(SALES);
    expect(ids.get('sale-1')).toBe(USER_A);
    expect(ids.get('sale-0')).toBeNull(); // no selling_user_id (legacy / manager sale)
    db.close();
  });

  it('a later tick over the same queue does not touch audit_events again (memoized)', () => {
    const { db, rows, resolver, auditSql } = backlog();
    resolver.resolve(rows, TERMINAL);
    resolver.resolve(rows, TERMINAL);
    resolver.resolve(rows.slice(0, 10), TERMINAL);
    expect(auditSql).toHaveLength(1);
    db.close();
  });

  it('only the sales not seen before are looked up, and a forgotten sale is read again', () => {
    const { db, rows, resolver, auditSql } = backlog();
    resolver.resolve(rows.slice(0, 100), TERMINAL);
    resolver.resolve(rows, TERMINAL);
    expect(auditSql).toHaveLength(2);
    resolver.forget('sale-1');
    expect(resolver.resolve(rows, TERMINAL).get('sale-1')).toBe(USER_A);
    expect(auditSql).toHaveLength(3);
    db.close();
  });

  it('the query reads audit_events in a single pass (EXPLAIN QUERY PLAN: one access, no per-sale loop)', () => {
    const { db, rows, resolver, auditSql } = backlog();
    resolver.resolve(rows, TERMINAL);
    const sql = nn(auditSql[0]);
    const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x');
    const plan = db.exec(`EXPLAIN QUERY PLAN ${sql}`, params);
    const details = (plan[0]?.values ?? []).map((row) => String(row[row.length - 1]));
    expect(details.filter((d) => /audit_events/.test(d))).toHaveLength(1);
    expect(details.some((d) => /\bsales\b/.test(d))).toBe(false);
    db.close();
  });
});
