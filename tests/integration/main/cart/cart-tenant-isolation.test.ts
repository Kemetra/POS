import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

/**
 * T039 — tenant isolation refusal.
 *
 * `cart.lines.add` with a `cart_id` owned by tenant T1 MUST be refused by
 * a session scoped to tenant T2 with `{ kind: 'refused', reason: 'tenant_isolation' }`
 * (FR-002). The refusal is generic (no factor-distinguishing detail).
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0050_carts_park.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'X', unit_price_minor: 100 });

function sessionFor(tenant_id: string, op: string = 'cashier-1'): OperatorSessionRecord {
  return {
    id: `sess-${tenant_id}`,
    operator_id: op,
    display_name: op,
    role: 'cashier',
    tenant_id,
    branch_id: 'branch-1',
    started_at: '2026-05-14T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-14T08:00:00.000Z',
  };
}

describe('tenant isolation (T039)', () => {
  it('cart.lines.add from T2 session against T1 cart refuses with tenant_isolation', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const store = bindCartStore(makeSqlJsHandle(db));

    // T1 cashier creates a cart.
    let currentSession: OperatorSessionRecord = sessionFor('tenant-1');
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => currentSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
      resolveItemRef: resolver,
    });
    const create = await handlers.create({ idempotency_key: 'iso-c' });
    if (create.kind !== 'ok') throw new Error('create failed');

    // Swap to a T2 cashier session (same handlers instance — getCurrentSession is a closure).
    currentSession = sessionFor('tenant-2', 'cashier-2');
    const r = await handlers.linesAdd({
      cart_id: create.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'iso-a',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('tenant_isolation');
  });

  it('refusal is generic — no factor-distinguishing fields beyond kind+reason', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const store = bindCartStore(makeSqlJsHandle(db));

    let currentSession: OperatorSessionRecord = sessionFor('tenant-1');
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => currentSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
      resolveItemRef: resolver,
    });
    const create = await handlers.create({ idempotency_key: 'iso2-c' });
    if (create.kind !== 'ok') throw new Error('create failed');

    currentSession = sessionFor('tenant-2');
    const r = await handlers.linesAdd({
      cart_id: create.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'iso2-a',
    });
    if (r.kind === 'refused') {
      expect(Object.keys(r).sort()).toEqual(['kind', 'reason']);
    }
  });
});
