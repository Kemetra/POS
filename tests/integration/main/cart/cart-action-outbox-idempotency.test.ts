import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

/**
 * T037 — idempotency replay invariant.
 *
 * Same `idempotency_key` (== `cart_action_outbox.action_id`) + same payload
 * twice → single outbox row, original outcome returned.
 *
 * Same `idempotency_key` + different payload → refused with
 * `idempotency_payload_mismatch`. The exact "payload mismatch" detection
 * is action_kind-aware: re-applying the same key with a different action
 * kind is considered a mismatch (the action_id identifies the operation,
 * not the line — FR-018 / `contracts/bridge-api.md §Idempotency`).
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

function newSession(): OperatorSessionRecord {
  return {
    id: 'sess-idem',
    operator_id: 'cashier-1',
    display_name: 'C',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-14T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-14T08:00:00.000Z',
  };
}

async function makeCart(): Promise<{
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
}> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => newSession(),
    getTerminalId: () => 'terminal-test-380',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: resolver,
    clock: () => new Date('2026-05-14T10:00:00.000Z'),
  });
  const c = await handlers.create({ idempotency_key: 'c-1' });
  if (c.kind !== 'ok') throw new Error('create failed');
  return { db, handlers, cart_id: c.cart_id };
}

function countOutbox(db: SqlJsDatabase, action_id: string): number {
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM cart_action_outbox WHERE action_id = ?');
  stmt.bind([action_id]);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row['c'] as number;
}

describe('idempotency — T037', () => {
  it('same idempotency_key + same payload returns the same outcome and writes ONE outbox row', async () => {
    const f = await makeCart();
    const KEY = 'add-idem';
    const req = {
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: KEY,
    };
    const r1 = await f.handlers.linesAdd(req);
    const r2 = await f.handlers.linesAdd(req);
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind === 'ok' && r2.kind === 'ok') {
      expect(r2.line_id).toBe(r1.line_id);
      expect(r2.version).toBe(r1.version);
    }
    expect(countOutbox(f.db, KEY)).toBe(1);
  });

  it('same idempotency_key reused for a different action kind is refused with idempotency_payload_mismatch', async () => {
    const f = await makeCart();
    const SHARED = 'shared-key';
    const add = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: SHARED,
    });
    if (add.kind !== 'ok') throw new Error('expected ok');
    // Replay the same key but as an unrelated mutation (cart.create context).
    const collision = await f.handlers.create({ idempotency_key: SHARED });
    expect(collision.kind).toBe('refused');
    if (collision.kind === 'refused') {
      expect(collision.reason).toBe('idempotency_payload_mismatch');
    }
  });

  it('on replay of a cart.line.remove the original outcome is returned', async () => {
    const f = await makeCart();
    const add = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'add-r',
    });
    if (add.kind !== 'ok') throw new Error('expected ok');
    const KEY = 'rem-idem';
    const r1 = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: add.line_id,
      version: 1,
      idempotency_key: KEY,
    });
    const r2 = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: add.line_id,
      version: 1,
      idempotency_key: KEY,
    });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    expect(countOutbox(f.db, KEY)).toBe(1);
  });
});
