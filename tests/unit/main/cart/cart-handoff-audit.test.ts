/**
 * T084 — cart.handoff_to_payment audit row carries all 5 FR-026 mandatory attrs.
 *
 * The 5 mandatory attributes on every AuditEvent:
 *   1. acting_operator_id
 *   2. operator_session_id  (mapped to session_id in AuditEvent)
 *   3. originating_terminal_id
 *   4. created_at
 *   5. action_category
 *
 * Plus: handoff_action_id in payload equals envelope.handoff_action_id.
 * Partial records MUST NOT persist (atomic transaction per construction algorithm).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

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

function makeSession(): OperatorSessionRecord {
  return {
    id: 'sess-audit',
    operator_id: 'cashier-audit-1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-audit-1',
    branch_id: 'branch-audit-1',
    started_at: '2026-05-17T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-17T08:00:00.000Z',
  };
}

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

function makeAuditCapture(): { emitter: AuditEmitter; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const emitter: AuditEmitter = {
    emit(event) {
      events.push(event);
    },
  };
  return { emitter, events };
}

describe('cart.handoff_to_payment audit (T084)', () => {
  it('emits exactly one audit event with action_category = cart.handoff_to_payment', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const { emitter, events } = makeAuditCapture();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      auditEmitter: emitter,
    });

    const c = await handlers.create({ idempotency_key: 'aud-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'aud-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'aud-h',
    });
    expect(res.kind).toBe('ok');
    expect(events).toHaveLength(1);
    expect(events[0]?.action_category).toBe('cart.handoff_to_payment');
  });

  it('audit event carries all 5 FR-026 mandatory attributes', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const { emitter, events } = makeAuditCapture();
    const session = makeSession();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      auditEmitter: emitter,
    });

    const c = await handlers.create({ idempotency_key: 'aud2-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'aud2-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'aud2-h',
    });

    expect(events).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const evt = events[0]!;

    // 1. acting_operator_id
    expect(evt.acting_operator_id).toBe(session.operator_id);
    // 2. session_id (operator_session_id)
    expect(evt.session_id).toBe(session.id);
    // 3. originating_terminal_id
    expect(typeof evt.originating_terminal_id).toBe('string');
    expect(evt.originating_terminal_id.length).toBeGreaterThan(0);
    // 4. created_at (ISO timestamp)
    expect(typeof evt.created_at).toBe('string');
    expect(evt.created_at.length).toBeGreaterThan(0);
    // 5. action_category
    expect(evt.action_category).toBe('cart.handoff_to_payment');
  });

  it('handoff_action_id in audit payload equals envelope.handoff_action_id', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const { emitter, events } = makeAuditCapture();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      auditEmitter: emitter,
    });

    const c = await handlers.create({ idempotency_key: 'aud3-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'aud3-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'aud3-h',
    });

    expect(res.kind).toBe('ok');
    expect(events).toHaveLength(1);
    if (res.kind === 'ok') {
      const payload = events[0]?.payload as { handoff_action_id?: string } | undefined;
      expect(payload?.handoff_action_id).toBe(res.envelope.handoff_action_id);
    }
  });

  it('no audit event is emitted when handoff is refused (stale version)', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const { emitter, events } = makeAuditCapture();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      auditEmitter: emitter,
    });

    const c = await handlers.create({ idempotency_key: 'aud4-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'aud4-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 999 }],
      idempotency_key: 'aud4-h',
    });

    expect(events).toHaveLength(0);
  });

  it('audit payload carries cart_id, handoff_action_id, line_count, subtotal_minor', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const { emitter, events } = makeAuditCapture();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      auditEmitter: emitter,
    });

    const c = await handlers.create({ idempotency_key: 'aud5-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 2,
      idempotency_key: 'aud5-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'aud5-h',
    });

    expect(res.kind).toBe('ok');
    expect(events).toHaveLength(1);
    const firstEvent = events[0];
    if (firstEvent === undefined) throw new Error('no audit event emitted');
    const payload = firstEvent.payload as {
      cart_id: string;
      handoff_action_id: string;
      line_count: number;
      subtotal_minor: number;
    };
    expect(payload.cart_id).toBe(c.cart_id);
    expect(typeof payload.handoff_action_id).toBe('string');
    expect(payload.line_count).toBe(1);
    expect(payload.subtotal_minor).toBe(300); // qty=2 * price=150
    expect(Number.isSafeInteger(payload.subtotal_minor)).toBe(true);
  });
});
