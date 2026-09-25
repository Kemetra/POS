import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Logger } from 'pino';

import { createCartBridgeHandlers } from '../wire-cart-handlers.js';
import { createCatalogueResolver } from '../../catalogue/resolve-item-ref.js';
import { createProductRepo } from '../../catalogue/product-repo.js';
import { AuditEmitter } from '../../audit/audit-emitter.js';
import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  seedProduct,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';

/**
 * 009 T042 — wiring 009's production resolver into `createCartBridgeHandlers`.
 *
 * The §A1 keystone: a PACKAGED build with the production resolver supplied
 * resolves a known active `product_id` and persists a cart line — replacing the
 * generic-refusal DEFAULT_ITEM_REF_RESOLVER. The dev fixture matrix (in
 * `tests/unit/main/cart/cart-wiring-production.test.ts`) is UNCHANGED: those
 * tests pass no `productionResolver`, so their behaviour is byte-identical.
 *
 * The resolver collapses at the `linesAdd` layer: any non-`ok` resolve maps to
 * a generic `refused` (cart-bridge.ts) — the precise reasons (unknown_item /
 * disabled / generic) are locked at the resolver level in
 * `src/main/catalogue/__tests__/resolve-item-ref.test.ts` (T040).
 *
 * `item_ref` = `product_id` (CATALOGUE_ITEM_REF_KIND).
 */

const TENANT = 'tenant-1';

let db: SqlJsDatabase | undefined;

beforeAll(async () => {
  await initCatalogueSql();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (db !== undefined) {
    db.close();
    db = undefined;
  }
});

function makeTestLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-009-s4-wiring',
    operator_id: 'cashier-009',
    display_name: 'S4 Wiring Cashier',
    role: 'cashier',
    tenant_id: TENANT,
    branch_id: 'branch-1',
    started_at: '2026-05-31T08:00:00.000Z',
    backend_session_id: 'bsess-009',
    last_activity_at: '2026-05-31T08:00:00.000Z',
  };
}

/**
 * Build handlers whose cart store AND catalogue resolver are backed by the same
 * full-migration sql.js db (the cart tables and the products table coexist).
 */
function handlersFor(opts: { isPackaged: boolean; withProductionResolver: boolean }) {
  if (db === undefined) throw new Error('seed db (freshCatalogueDb) first');
  const dbHandle = handleFor(db);
  const session = makeSession();

  const productionResolver = opts.withProductionResolver
    ? createCatalogueResolver({
        repo: createProductRepo(dbHandle),
        getTenantId: () => session.tenant_id,
      })
    : undefined;

  return createCartBridgeHandlers({
    dbHandle,
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-test',
    logger: makeTestLogger(),
    auditEmitter: new AuditEmitter({ insertIgnore: () => {} }),
    isPackaged: opts.isPackaged,
    // Required by the factory since the post-handoff cancel payment guard; no payments here.
    cartPaymentStatus: () => 'none',
    ...(productionResolver !== undefined ? { productionResolver } : {}),
  });
}

async function createCart(
  handlers: ReturnType<typeof handlersFor>,
  idempotency_key: string,
): Promise<string> {
  const res = await handlers.create({ idempotency_key });
  if (res.kind !== 'ok') throw new Error(`cart.create refused: ${JSON.stringify(res)}`);
  return res.cart_id;
}

describe('009 production resolver wiring (T042)', () => {
  it('packaged build + production resolver resolves a known product_id and persists the line', async () => {
    db = freshCatalogueDb();
    seedProduct(db, {
      product_id: 'p-1',
      tenant_id: TENANT,
      name_ar: 'بنادول إكسترا',
      price_minor: 1500,
      active: 1,
    });

    const handlers = handlersFor({ isPackaged: true, withProductionResolver: true });
    const cartId = await createCart(handlers, 'ik-s4-create-1');

    const add = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'p-1',
      quantity: 1,
      idempotency_key: 'ik-s4-add-1',
    });

    expect(add.kind).toBe('ok');
    if (add.kind !== 'ok') return;
    // The snapshot is read AUTHORITATIVELY from the read model (Arabic name +
    // price); the renderer supplies neither.
    expect(add.display_name).toBe('بنادول إكسترا');
    expect(add.unit_price_minor).toBe(1500);

    // Row persisted under the product_id item_ref.
    const stmt = db.prepare(
      'SELECT item_ref, display_name FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL',
    );
    stmt.bind([cartId]);
    const rows: { item_ref: string; display_name: string }[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as { item_ref: string; display_name: string });
    stmt.free();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item_ref).toBe('p-1');
  });

  it('refuses an unknown product_id (collapsed to a generic cart refusal)', async () => {
    db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-1', tenant_id: TENANT, active: 1 });

    const handlers = handlersFor({ isPackaged: true, withProductionResolver: true });
    const cartId = await createCart(handlers, 'ik-s4-create-2');

    const add = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'p-nope',
      quantity: 1,
      idempotency_key: 'ik-s4-add-2',
    });
    expect(add.kind).toBe('refused');
  });

  it('refuses an inactive product (FR-18 sellable guard)', async () => {
    db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-off', tenant_id: TENANT, active: 0 });

    const handlers = handlersFor({ isPackaged: true, withProductionResolver: true });
    const cartId = await createCart(handlers, 'ik-s4-create-3');

    const add = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'p-off',
      quantity: 1,
      idempotency_key: 'ik-s4-add-3',
    });
    expect(add.kind).toBe('refused');
  });

  it('without a production resolver, a packaged build still refuses generically (005 fallback unchanged)', async () => {
    db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-1', tenant_id: TENANT, active: 1 });

    const handlers = handlersFor({ isPackaged: true, withProductionResolver: false });
    const cartId = await createCart(handlers, 'ik-s4-create-4');

    const add = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'p-1',
      quantity: 1,
      idempotency_key: 'ik-s4-add-4',
    });
    // DEFAULT_ITEM_REF_RESOLVER refuses everything — the pre-009 behaviour.
    expect(add.kind).toBe('refused');
  });

  it('duplicate scan of the same product_id increments via 005 merge, not a 2nd line (FR-21)', async () => {
    db = freshCatalogueDb();
    seedProduct(db, {
      product_id: 'p-1',
      tenant_id: TENANT,
      name_ar: 'بنادول',
      price_minor: 1500,
      active: 1,
    });

    const handlers = handlersFor({ isPackaged: true, withProductionResolver: true });
    const cartId = await createCart(handlers, 'ik-s4-create-5');

    const add1 = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'p-1',
      quantity: 1,
      idempotency_key: 'ik-s4-add-5a',
    });
    const add2 = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'p-1',
      quantity: 2,
      idempotency_key: 'ik-s4-add-5b',
    });

    expect(add1.kind).toBe('ok');
    expect(add2.kind).toBe('ok');
    if (add2.kind !== 'ok') return;
    expect(add2.merged).toBe(true);
    expect(add2.quantity).toBe(3);

    const stmt = db.prepare(
      'SELECT line_id FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL',
    );
    stmt.bind([cartId]);
    const rows: { line_id: string }[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as { line_id: string });
    stmt.free();
    expect(rows).toHaveLength(1);
  });
});
