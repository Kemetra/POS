/**
 * T082 — Handoff idempotency.
 *
 * Same idempotency_key submitted twice:
 * - One envelope created, one cart.handoff_to_payment audit event.
 * - Original { kind: 'ok', envelope } returned on replay.
 * - Replayed envelope is re-frozen.
 *
 * Same idempotency_key + different cart (different action context):
 * - idempotency_payload_mismatch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
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

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-idem-h',
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

function makeAuditCapture(): { emitter: AuditEmitter; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    emitter: {
      emit: (e) => {
        events.push(e);
      },
    },
    events,
  };
}

function countOutbox(db: SqlJsDatabase, action_id: string): number {
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM cart_action_outbox WHERE action_id = ?');
  stmt.bind([action_id]);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row['c'] as number;
}

async function makeCartWithLine(): Promise<{
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
  line_id: string;
  auditCapture: { emitter: AuditEmitter; events: AuditEvent[] };
}> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const { emitter, events } = makeAuditCapture();
  const handlers = new CartBridgeHandlers({
    getCurrentSession: makeSession,
    getTerminalId: () => 'terminal-test-380',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: resolver,
    auditEmitter: emitter,
    clock: () => new Date('2026-05-17T10:00:00.000Z'),
  });
  const c = await handlers.create({ idempotency_key: 'idem-h-c' });
  if (c.kind !== 'ok') throw new Error('create failed');
  const a = await handlers.linesAdd({
    cart_id: c.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'idem-h-a',
  });
  if (a.kind !== 'ok') throw new Error('add failed');
  return {
    db,
    handlers,
    cart_id: c.cart_id,
    line_id: a.line_id,
    auditCapture: { emitter, events },
  };
}

describe('cart.handoff idempotency (T082)', () => {
  it('second call with same idempotency_key returns the same ok envelope', async () => {
    const f = await makeCartWithLine();
    const KEY = 'idem-hoff-1';
    const r1 = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });
    const r2 = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });

    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind === 'ok' && r2.kind === 'ok') {
      expect(r2.envelope.handoff_action_id).toBe(r1.envelope.handoff_action_id);
      expect(r2.envelope.cart_id).toBe(r1.envelope.cart_id);
      expect(r2.envelope.subtotal_minor).toBe(r1.envelope.subtotal_minor);
    }
  });

  it('second call writes only ONE outbox row for the handoff action', async () => {
    const f = await makeCartWithLine();
    const KEY = 'idem-hoff-2';
    await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });
    await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });
    expect(countOutbox(f.db, KEY)).toBe(1);
  });

  it('audit event is emitted exactly once even on replay', async () => {
    const f = await makeCartWithLine();
    const KEY = 'idem-hoff-3';
    await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });
    await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });
    const handoffEvents = f.auditCapture.events.filter(
      (e) => e.action_category === 'cart.handoff_to_payment',
    );
    expect(handoffEvents).toHaveLength(1);
  });

  it('replayed envelope is frozen (Object.isFrozen)', async () => {
    const f = await makeCartWithLine();
    const KEY = 'idem-hoff-4';
    await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });
    const r2 = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [{ line_id: f.line_id, version: 1 }],
      idempotency_key: KEY,
    });
    expect(r2.kind).toBe('ok');
    if (r2.kind === 'ok') {
      expect(Object.isFrozen(r2.envelope)).toBe(true);
      expect(Object.isFrozen(r2.envelope.lines)).toBe(true);
    }
  });

  it('same idempotency_key used for a different action kind returns idempotency_payload_mismatch', async () => {
    const f = await makeCartWithLine();
    const SHARED_KEY = 'idem-hoff-shared';
    // Use the key for lines.add first
    const addRes = await f.handlers.linesAdd({
      cart_id: f.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: SHARED_KEY,
    });
    // Q4 merge — will succeed
    expect(addRes.kind).toBe('ok');

    // Now try handoff with the same key
    const res = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [
        { line_id: f.line_id, version: addRes.kind === 'ok' ? addRes.version : 2 },
      ],
      idempotency_key: SHARED_KEY,
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('idempotency_payload_mismatch');
  });
});
