import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

/**
 * T038 — cart draft survives application restart (FR-028).
 *
 * Build a 2-line cart with 1 note; serialise the SQLite database;
 * reopen via a fresh `SQL.Database(bytes)` (the model for "fresh
 * process opening the same file"); confirm lines, versions, and note
 * are exactly preserved.
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

const resolver: ItemRefResolver = (item_ref) => {
  const fixtures: Record<string, { display_name: string; unit_price_minor: number }> = {
    'SKU-A': { display_name: 'Aspirin', unit_price_minor: 150 },
    'SKU-B': { display_name: 'Bandage', unit_price_minor: 80 },
  };
  const f = fixtures[item_ref];
  if (f === undefined) return Promise.resolve({ kind: 'refused', reason: 'unknown_item' });
  return Promise.resolve({ kind: 'ok', ...f });
};

function session(): OperatorSessionRecord {
  return {
    id: 'sess-r',
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

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  return db;
}

function reopenDb(bytes: Uint8Array): SqlJsDatabase {
  // Model: a fresh process opens the same SQLite file.
  return new SQL.Database(bytes);
}

describe('cart draft survives application restart (T038)', () => {
  it('2 lines + 1 note reload with identical versions and note text', async () => {
    let db = freshDb();
    let handlers = new CartBridgeHandlers({
      getCurrentSession: () => session(),
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-14T10:00:00.000Z'),
    });
    const c = await handlers.create({ idempotency_key: 'r-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'r-a-1',
    });
    const b = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-B',
      quantity: 3,
      idempotency_key: 'r-a-2',
    });
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('adds failed');
    await handlers.linesSetNote({
      cart_id: c.cart_id,
      line_id: a.line_id,
      note: 'fragile',
      version: 1,
      idempotency_key: 'r-n',
    });

    // Simulate restart: serialise then reopen.
    const bytes = db.export();
    db.close();
    db = reopenDb(bytes);
    handlers = new CartBridgeHandlers({
      getCurrentSession: () => session(),
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-14T10:00:00.000Z'),
    });

    // Verify state survived.
    const stmt = db.prepare(
      `SELECT line_id, quantity, unit_price_minor, line_subtotal_minor, note, version
         FROM cart_lines WHERE cart_id = ? ORDER BY item_ref`,
    );
    stmt.bind([c.cart_id]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['quantity']).toBe(2); // SKU-A
    expect(rows[0]?.['note']).toBe('fragile');
    expect(rows[0]?.['version']).toBe(2); // 1 add + 1 note_set
    expect(rows[1]?.['quantity']).toBe(3); // SKU-B
    expect(rows[1]?.['version']).toBe(1);

    // Subsequent mutation post-restart uses the surviving version token.
    const upd = await handlers.linesUpdate({
      cart_id: c.cart_id,
      line_id: a.line_id,
      op: 'increment',
      delta: 1,
      version: 2,
      idempotency_key: 'r-u',
    });
    expect(upd.kind).toBe('ok');
    if (upd.kind === 'ok') expect(upd.version).toBe(3);
  });
});
