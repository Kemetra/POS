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
import { seedSettled, type SeedSettledInput } from './__helpers__/settled-audit-fixture.js';
import type { Database as SqlJsDatabase } from 'sql.js';

import type { DatabaseHandle } from '../../db/client.js';
import { bindSalesRepository, type SaleRow } from '../../sales/repositories/sales.repository.js';
import {
  createSellingUserIdResolver,
  type SaleRoute,
  type SellingUserUnresolved,
} from '../selling-user-id.js';

beforeAll(async () => {
  await initSalesSyncSql();
});

const USER_A = '0190a3c4-0000-7000-8000-00000000000a';
const USER_B = '0190a3c4-0000-7000-8000-00000000000b';
const TERMINAL = 'term-1';

const DEVICE_A = { kind: 'device', operatorUserId: USER_A } as const;
const ENVELOPE = { kind: 'envelope' } as const;
const HOLD = { kind: 'hold' } as const;

function setup() {
  const db = freshSalesSyncDb();
  const handle = handleFor(db);
  const sales = bindSalesRepository(handle);
  const unresolved: SellingUserUnresolved[] = [];
  const lookupFailures: unknown[][] = [];
  const resolver = createSellingUserIdResolver({
    db: handle,
    onUnresolved: (info) => unresolved.push(info),
    onLookupFailed: (...args: unknown[]) => lookupFailures.push(args),
  });
  const read = (one: SaleRow, terminalId: string): SaleRoute | undefined =>
    resolver.resolve([one], terminalId).get(one.sale_id);
  const sale = (id: string) => nn(sales.readById(id));
  return { db, handle, read, sale, unresolved, lookupFailures, resolver };
}

describe('RT-224 — each sale is routed from its own payment.settled payload', () => {
  it('a UUID selling_user_id → the device path with that cashier', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toEqual(DEVICE_A);
    expect(unresolved).toEqual([]);
    db.close();
  });

  it('reads each sale’s own row, never another sale’s (two cashiers, two sales)', () => {
    const { db, read, sale } = setup();
    seedSale(db, { sale_id: 'sale-a' });
    seedSale(db, { sale_id: 'sale-b' });
    seedSettled(db, { sale_id: 'sale-a', selling_user_id: USER_A });
    seedSettled(db, { sale_id: 'sale-b', selling_user_id: USER_B });
    expect(read(sale('sale-a'), TERMINAL)).toEqual(DEVICE_A);
    expect(read(sale('sale-b'), TERMINAL)).toEqual({ kind: 'device', operatorUserId: USER_B });
    db.close();
  });

  it('no selling_user_id key (manager/admin or pre-RT-224 sale) → the envelope path, silently', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1' });
    expect(read(sale('sale-1'), TERMINAL)).toEqual(ENVELOPE);
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
    expect(read(sale('sale-1'), TERMINAL)).toEqual(DEVICE_A);
    expect(unresolved).toEqual([]);
    db.close();
  });

  it('F4a: the sale’s own attempt is chosen when another attempt settled the same handoff', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, { sale_id: 'sale-1', payment_attempt_id: 'pa-OTHER', selling_user_id: USER_B });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toEqual(DEVICE_A);
    expect(unresolved).toEqual([]);
    db.close();
  });

  it('a sale of another terminal than the drain’s → held + terminal_mismatch', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1', terminal_id: 'term-OLD' });
    seedSettled(db, { sale_id: 'sale-1', terminal_id: 'term-OLD', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toEqual(HOLD);
    expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'terminal_mismatch' }]);
    db.close();
  });

  it.each<{
    name: string;
    rows: SeedSettledInput[];
    route: SaleRoute;
    reason: SellingUserUnresolved['reason'];
  }>([
    {
      name: 'a row of another attempt only is not this sale’s → envelope',
      rows: [{ payment_attempt_id: 'pa-OTHER', selling_user_id: USER_A }],
      route: ENVELOPE,
      reason: 'no_settled_event',
    },
    {
      name: 'only another sale’s row → envelope',
      rows: [{ sale_id: 'sale-OTHER', selling_user_id: USER_B }],
      route: ENVELOPE,
      reason: 'no_settled_event',
    },
    {
      name: 'several own rows, one carrying the key → HELD (never sent under a manager)',
      rows: [{ selling_user_id: USER_A }, {}],
      route: HOLD,
      reason: 'multiple_settled_events',
    },
    {
      name: 'several own rows, none carrying the key → envelope',
      rows: [{}, {}],
      route: ENVELOPE,
      reason: 'multiple_settled_events',
    },
    {
      name: 'another operator’s row carrying the key → HELD',
      rows: [{ attribution_operator_id: 'op-OTHER', selling_user_id: USER_A }],
      route: HOLD,
      reason: 'settled_event_mismatch',
    },
    {
      name: 'another operator’s row without the key → envelope',
      rows: [{ attribution_operator_id: 'op-OTHER' }],
      route: ENVELOPE,
      reason: 'settled_event_mismatch',
    },
  ])('$name ($reason)', ({ rows, route, reason }) => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    for (const row of rows) seedSettled(db, { sale_id: 'sale-1', ...row });
    expect(read(sale('sale-1'), TERMINAL)).toEqual(route);
    expect(unresolved).toEqual([{ saleId: 'sale-1', reason }]);
    db.close();
  });

  it.each([[''], ['not-a-uuid'], [42], [null]])(
    'F4b: a malformed selling_user_id (%j) → HELD + malformed_selling_user_id (never the envelope)',
    (bad) => {
      const { db, read, sale, unresolved } = setup();
      seedSale(db, { sale_id: 'sale-1' });
      seedSettled(db, { sale_id: 'sale-1', selling_user_id: bad });
      expect(read(sale('sale-1'), TERMINAL)).toEqual(HOLD);
      expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'malformed_selling_user_id' }]);
      db.close();
    },
  );

  it('reports an unresolved sale ONCE, however often it is read', () => {
    const { db, read, sale, unresolved, resolver } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    for (let i = 0; i < 5; i += 1) {
      expect(read(sale('sale-1'), TERMINAL)).toEqual(ENVELOPE);
      resolver.forget('sale-1');
    }
    expect(unresolved).toEqual([{ saleId: 'sale-1', reason: 'no_settled_event' }]);
    db.close();
  });

  it('the unresolved report carries only { saleId, reason } — never a user id', () => {
    const { db, read, sale, unresolved } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSettled(db, {
      sale_id: 'sale-1',
      attribution_operator_id: 'op-OTHER',
      selling_user_id: USER_A,
    });
    read(sale('sale-1'), TERMINAL);
    expect(Object.keys(nn(unresolved[0])).sort()).toEqual(['reason', 'saleId']);
    expect(JSON.stringify(unresolved)).not.toContain(USER_A);
    db.close();
  });
});

describe('RT-224 (rev547 F6) — a bad audit row or a failing lookup never stops the drain', () => {
  it('a malformed-JSON payment.settled row elsewhere does not break the lookup', () => {
    const { db, read, sale, lookupFailures } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    db.run(
      `INSERT INTO audit_events
         (event_id, tenant_id, branch_id, originating_terminal_id, acting_operator_id, session_id,
          shift_id, action_category, created_at, approving_supervisor_id, payload)
       VALUES ('evt-bad', 'tenant-1', 'branch-1', 'term-1', 'op-1', 'sess-1', NULL,
               'payment.settled', '2026-06-07T10:00:00.000Z', NULL, '{not json')`,
    );
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    expect(read(sale('sale-1'), TERMINAL)).toEqual(DEVICE_A);
    expect(lookupFailures).toEqual([]);
    db.close();
  });

  it('a lookup that throws HOLDS the batch (not memoized), is reported once, and is retried', () => {
    const { db, handle, sale } = setup();
    seedSale(db, { sale_id: 'sale-1' });
    seedSale(db, { sale_id: 'sale-2' });
    seedSettled(db, { sale_id: 'sale-1', selling_user_id: USER_A });
    seedSettled(db, { sale_id: 'sale-2' });
    let failing = true;
    const failures: unknown[][] = [];
    const resolver = createSellingUserIdResolver({
      db: {
        ...handle,
        prepare: (sql: string) => {
          if (failing && sql.includes('audit_events'))
            throw new Error('SQLITE_ERROR: malformed JSON');
          return handle.prepare(sql);
        },
      },
      onLookupFailed: (...args: unknown[]) => failures.push(args),
    });
    const both = [sale('sale-1'), sale('sale-2')];
    expect([...resolver.resolve(both, TERMINAL).values()]).toEqual([HOLD, HOLD]);
    expect([...resolver.resolve(both, TERMINAL).values()]).toEqual([HOLD, HOLD]);
    expect(failures).toEqual([[]]);
    failing = false;
    expect([...resolver.resolve(both, TERMINAL).values()]).toEqual([DEVICE_A, ENVELOPE]);
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
  // rev547 F5: any backlog is ONE scan (no 500-sale chunking).
  const SALES = 1200;

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

  it('1200 queued sales over a 20k-row audit table: ONE query resolves them all', () => {
    const { db, rows, resolver, auditSql } = backlog();
    const ids = resolver.resolve(rows, TERMINAL);
    expect(auditSql).toHaveLength(1);
    expect(ids.size).toBe(SALES);
    expect(ids.get('sale-1')).toEqual(DEVICE_A);
    expect(ids.get('sale-0')).toEqual(ENVELOPE); // no selling_user_id (legacy / manager sale)
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
    expect(resolver.resolve(rows, TERMINAL).get('sale-1')).toEqual(DEVICE_A);
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
