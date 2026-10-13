/**
 * T083 — Envelope persistence: after handoff, app restart, carts.handoff_envelope_json
 * is readable; rehydrated envelope is re-frozen (bridge re-applies Object.freeze on parse).
 *
 * Model: sql.js db.export() → db.close() → new SQL.Database(bytes) simulates restart.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
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
  const m: Record<string, { display_name: string; unit_price_minor: number }> = {
    'SKU-A': { display_name: 'Aspirin', unit_price_minor: 150 },
    'SKU-B': { display_name: 'Bandage', unit_price_minor: 80 },
  };
  const f = m[item_ref];
  if (!f) return Promise.resolve({ kind: 'refused', reason: 'unknown_item' });
  return Promise.resolve({ kind: 'ok', ...f });
};

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-persist',
    operator_id: 'cashier-1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-17T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-17T08:00:00.000Z',
  };
}

describe('envelope persistence across restart (T083)', () => {
  it('handoff_envelope_json is written to carts table after handoff', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-17T10:00:00.000Z'),
    });

    const c = await handlers.create({ idempotency_key: 'per-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'per-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'per-h',
    });

    const stmt = db.prepare(
      'SELECT handoff_envelope_json, frozen_at, state FROM carts WHERE cart_id = ?',
    );
    stmt.bind([c.cart_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();

    expect(row['state']).toBe('frozen_handed_off');
    expect(typeof row['handoff_envelope_json']).toBe('string');
    expect(row['frozen_at']).toBeTruthy();

    const parsed = JSON.parse(row['handoff_envelope_json'] as string) as Record<string, unknown>;
    expect(parsed['envelope_version']).toBe('v1');
    expect(parsed['cart_id']).toBe(c.cart_id);
  });

  it('after app restart, handoff idempotency replay returns frozen envelope', async () => {
    let db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers1 = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-17T10:00:00.000Z'),
    });

    const c = await handlers1.create({ idempotency_key: 'per2-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers1.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'per2-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    const r1 = await handlers1.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'per2-h',
    });
    expect(r1.kind).toBe('ok');

    // Simulate restart
    const bytes = db.export();
    db.close();
    db = new SQL.Database(bytes);

    const handlers2 = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-17T11:00:00.000Z'),
    });

    // Replay with same idempotency_key — should return original envelope
    const r2 = await handlers2.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'per2-h',
    });
    expect(r2.kind).toBe('ok');
    if (r2.kind === 'ok' && r1.kind === 'ok') {
      expect(r2.envelope.cart_id).toBe(r1.envelope.cart_id);
      expect(r2.envelope.handoff_action_id).toBe(r1.envelope.handoff_action_id);
      expect(r2.envelope.subtotal_minor).toBe(r1.envelope.subtotal_minor);
      // Replayed envelope must be re-frozen
      expect(Object.isFrozen(r2.envelope)).toBe(true);
      expect(Object.isFrozen(r2.envelope.lines)).toBe(true);
    }
  });

  it('persisted envelope contains correct line snapshots', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-17T10:00:00.000Z'),
    });

    const c = await handlers.create({ idempotency_key: 'per3-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'per3-a',
    });
    const b = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-B',
      quantity: 3,
      idempotency_key: 'per3-b',
    });
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('add failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [
        { line_id: a.line_id, version: 1 },
        { line_id: b.line_id, version: 1 },
      ],
      idempotency_key: 'per3-h',
    });

    const stmt = db.prepare('SELECT handoff_envelope_json FROM carts WHERE cart_id = ?');
    stmt.bind([c.cart_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();

    const parsed = JSON.parse(row['handoff_envelope_json'] as string) as {
      lines: Array<{ quantity: number; unit_price_minor: number; line_subtotal_minor: number }>;
      subtotal_minor: number;
    };

    expect(parsed.lines).toHaveLength(2);
    expect(parsed.subtotal_minor).toBe(300 + 240); // 2*150 + 3*80
    expect(res.kind).toBe('ok');
  });
});
