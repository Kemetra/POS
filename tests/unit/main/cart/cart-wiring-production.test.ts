import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Logger } from 'pino';

import { createCartBridgeHandlers } from '../../../../src/main/cart/wire-cart-handlers.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import { isShippedApp } from '../../../../src/main/app/shipped-app.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';

/**
 * T100 regression — production `createCartBridgeHandlers` wires a
 * DB-backed CartStore so that `cart.create` writes a row to SQLite.
 *
 * Before the fix, `src/main/index.ts` constructed `CartBridgeHandlers`
 * without `cartStore`, causing the handler to fall back to the in-memory
 * Map. This test would fail in that configuration because the `carts`
 * table would remain empty even after a successful `create` response.
 *
 * After the fix, `createCartBridgeHandlers` supplies `bindCartStore(dbHandle)`
 * and the INSERT lands in SQLite.
 *
 * Additional tests (Option B fixture resolver) verify the `isPackaged` +
 * `POS_PULSE_DEV_ITEM_RESOLVER` wiring matrix:
 *   - unpackaged + flag set   → fixture resolver wired; line persists
 *   - packaged   + flag set   → fixture resolver NOT wired; item ref refused
 *   - unpackaged + flag absent → fixture resolver NOT wired; item ref refused
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');

const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

afterEach(() => {
  vi.unstubAllEnvs();
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

function makeTestAuditEmitter(): AuditEmitter {
  return new AuditEmitter({ insertIgnore: () => {} });
}

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  return db;
}

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-t100-wiring',
    operator_id: 'cashier-wiring',
    display_name: 'Wiring Test Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-14T08:00:00.000Z',
    backend_session_id: 'bsess-wiring',
    last_activity_at: '2026-05-14T08:00:00.000Z',
  };
}

describe('production cart wiring (T100 regression)', () => {
  it('createCartBridgeHandlers writes a row to SQLite on cart.create', async () => {
    const sqlJsDb = freshDb();
    const dbHandle = makeSqlJsHandle(sqlJsDb);
    const session = makeSession();

    // createCartBridgeHandlers is the production entry point used by
    // src/main/index.ts — it must wire cartStore or this assertion fails.
    const handlers = createCartBridgeHandlers({
      dbHandle,
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      logger: makeTestLogger(),
      auditEmitter: makeTestAuditEmitter(),
      isPackaged: true,
    });

    const result = await handlers.create({ idempotency_key: 'ikey-t100-wiring' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const cartId = result.cart_id;

    // Query the live SQLite database to verify the row was persisted.
    // If cartStore was not wired (in-memory fallback), this query returns
    // zero rows and the test fails — which is the pre-fix failure mode.
    const stmt = sqlJsDb.prepare('SELECT cart_id, state FROM carts WHERE cart_id = ?');
    stmt.bind([cartId]);
    const rows: { cart_id: string; state: string }[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as { cart_id: string; state: string });
    }
    stmt.free();

    expect(rows).toHaveLength(1);
    expect(rows[0].cart_id).toBe(cartId);
    // CartState.empty is the initial state for a newly-created cart.
    expect(rows[0].state).toBe('empty');
  });
});

describe('dev fixture resolver wiring matrix (Option B)', () => {
  it('wires fixture resolver when isPackaged=false and POS_PULSE_DEV_ITEM_RESOLVER=1', async () => {
    vi.stubEnv('POS_PULSE_DEV_ITEM_RESOLVER', '1');

    const sqlJsDb = freshDb();
    const dbHandle = makeSqlJsHandle(sqlJsDb);
    const session = makeSession();

    const handlers = createCartBridgeHandlers({
      dbHandle,
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      logger: makeTestLogger(),
      auditEmitter: makeTestAuditEmitter(),
      isPackaged: false,
    });

    const createResult = await handlers.create({ idempotency_key: 'ikey-t100-fixture-dev' });
    expect(createResult.kind).toBe('ok');
    if (createResult.kind !== 'ok') return;

    const cartId = createResult.cart_id;

    // SKU-PARA-500 is a fixture item; fixture resolver is wired here.
    const addResult = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'SKU-PARA-500',
      quantity: 1,
      idempotency_key: 'ikey-t100-line-dev',
    });

    expect(addResult.kind).toBe('ok');
    if (addResult.kind !== 'ok') return;

    // Verify the line was persisted to SQLite.
    const stmt = sqlJsDb.prepare(
      'SELECT line_id, item_ref FROM cart_lines WHERE cart_id = ? AND removed_at IS NULL',
    );
    stmt.bind([cartId]);
    const rows: { line_id: string; item_ref: string }[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as { line_id: string; item_ref: string });
    }
    stmt.free();

    expect(rows).toHaveLength(1);
    expect(rows[0].item_ref).toBe('SKU-PARA-500');
  });

  it('does NOT wire fixture resolver when isPackaged=true, even with POS_PULSE_DEV_ITEM_RESOLVER=1', async () => {
    vi.stubEnv('POS_PULSE_DEV_ITEM_RESOLVER', '1');

    const sqlJsDb = freshDb();
    const dbHandle = makeSqlJsHandle(sqlJsDb);
    const session = makeSession();

    const handlers = createCartBridgeHandlers({
      dbHandle,
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      logger: makeTestLogger(),
      auditEmitter: makeTestAuditEmitter(),
      isPackaged: true,
    });

    const createResult = await handlers.create({ idempotency_key: 'ikey-t100-fixture-pkg' });
    expect(createResult.kind).toBe('ok');
    if (createResult.kind !== 'ok') return;

    const cartId = createResult.cart_id;

    // Packaged build must refuse even fixture SKUs — DEFAULT_ITEM_REF_RESOLVER is used.
    const addResult = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'SKU-PARA-500',
      quantity: 1,
      idempotency_key: 'ikey-t100-line-pkg',
    });

    expect(addResult.kind).toBe('refused');
  });

  // RT-165 — a renamed copy of the shipped exe reports app.isPackaged=false
  // but still runs resources/app.asar; it must not ring up fixture items.
  it('does NOT wire fixture resolver for a renamed shipped exe (isPackaged=false, app.asar) with POS_PULSE_DEV_ITEM_RESOLVER=1', async () => {
    vi.stubEnv('POS_PULSE_DEV_ITEM_RESOLVER', '1');

    const sqlJsDb = freshDb();
    const handlers = createCartBridgeHandlers({
      dbHandle: makeSqlJsHandle(sqlJsDb),
      getCurrentSession: () => makeSession(),
      getTerminalId: () => 'terminal-test-380',
      logger: makeTestLogger(),
      auditEmitter: makeTestAuditEmitter(),
      isPackaged: isShippedApp({ isPackaged: false, appPath: 'C:\\copy\\resources\\app.asar' }),
    });

    const createResult = await handlers.create({ idempotency_key: 'ikey-rt165-renamed' });
    expect(createResult.kind).toBe('ok');
    if (createResult.kind !== 'ok') return;

    const addResult = await handlers.linesAdd({
      cart_id: createResult.cart_id,
      item_ref: 'SKU-PARA-500',
      quantity: 1,
      idempotency_key: 'ikey-rt165-renamed-line',
    });

    expect(addResult.kind).toBe('refused');
  });

  it('does NOT wire fixture resolver when isPackaged=false and POS_PULSE_DEV_ITEM_RESOLVER is absent', async () => {
    // Env flag is not set — fixture resolver must NOT be wired.
    const sqlJsDb = freshDb();
    const dbHandle = makeSqlJsHandle(sqlJsDb);
    const session = makeSession();

    const handlers = createCartBridgeHandlers({
      dbHandle,
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      logger: makeTestLogger(),
      auditEmitter: makeTestAuditEmitter(),
      isPackaged: false,
    });

    const createResult = await handlers.create({ idempotency_key: 'ikey-t100-fixture-noflag' });
    expect(createResult.kind).toBe('ok');
    if (createResult.kind !== 'ok') return;

    const cartId = createResult.cart_id;

    const addResult = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'SKU-PARA-500',
      quantity: 1,
      idempotency_key: 'ikey-t100-line-noflag',
    });

    expect(addResult.kind).toBe('refused');
  });
});
