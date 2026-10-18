/**
 * Coverage gap tests for S4 handoff paths not exercised by primary test files.
 *
 * Covers:
 * 1. handoff() with no cartStore (S1 in-memory fallback) → not_implemented
 * 2. subtotal_unsafe path in buildPaymentIntentEnvelope
 * 3. cart-store findLatestHandoffActionId (returns action_id after handoff)
 * 4. cart-store findDraftCartBySession (finds non-terminal cart for session)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import { buildPaymentIntentEnvelope } from '../../../../src/main/cart/handoff-envelope-builder.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { CartStore } from '../../../../src/main/cart/cart-store.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
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

function makeSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-cov',
    operator_id: 'cashier-cov',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-cov',
    branch_id: 'branch-cov',
    started_at: '2026-05-17T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-17T08:00:00.000Z',
    ...overrides,
  };
}

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

// ── 1. handoff() S1 in-memory fallback ─────────────────────────────────────

describe('handoff() S1 in-memory fallback (no cartStore)', () => {
  it('returns refused not_implemented when cartStore is omitted', async () => {
    const session = makeSession({ id: 'sess-s1-h', operator_id: 'cashier-s1' });
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      // no cartStore — S1 path
    });

    // First create a cart in in-memory mode
    const c = await handlers.create({ idempotency_key: 's1h-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [],
      idempotency_key: 's1h-h',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('not_implemented');
  });

  it('returns refused wrong_owner for unknown cart_id in S1 mode', async () => {
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => makeSession({ id: 'sess-s1-x' }),
      getTerminalId: () => 'terminal-test-380',
    });

    const res = await handlers.handoff({
      cart_id: 'nonexistent-cart',
      per_line_versions: [],
      idempotency_key: 's1h-x',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('wrong_owner');
  });
});

// ── 2. subtotal_unsafe in buildPaymentIntentEnvelope ───────────────────────

describe('buildPaymentIntentEnvelope subtotal_unsafe path', () => {
  it('returns subtotal_unsafe when sum exceeds Number.MAX_SAFE_INTEGER', () => {
    const session = makeSession();

    // Stub store that returns lines whose subtotals overflow safe integer
    const overflowStore: Pick<CartStore, 'getActiveLines' | 'getDiscountPlaceholdersForCart'> = {
      getActiveLines: () => [
        {
          line_id: 'line-1',
          cart_id: 'cart-cov',
          item_ref: 'SKU-X',
          display_name: 'Overflow Item',
          quantity: 1,
          unit_price_minor: Number.MAX_SAFE_INTEGER,
          line_subtotal_minor: Number.MAX_SAFE_INTEGER,
          note: null,
          version: 1,
          last_action_id: 'act-1',
          created_at: '2026-05-17T10:00:00.000Z',
          updated_at: '2026-05-17T10:00:00.000Z',
          removed_at: null,
        },
        {
          line_id: 'line-2',
          cart_id: 'cart-cov',
          item_ref: 'SKU-Y',
          display_name: 'Overflow Item 2',
          quantity: 1,
          unit_price_minor: 1,
          line_subtotal_minor: 1,
          note: null,
          version: 1,
          last_action_id: 'act-2',
          created_at: '2026-05-17T10:00:00.000Z',
          updated_at: '2026-05-17T10:00:00.000Z',
          removed_at: null,
        },
      ],
      getDiscountPlaceholdersForCart: () => [],
    };

    const result = buildPaymentIntentEnvelope({
      cart_id: 'cart-cov',
      handoff_action_id: 'act-h',
      session,
      terminal_id: 'term-1',
      tenant_id: 'tenant-cov',
      branch_id: 'branch-cov',
      created_at: '2026-05-17T10:00:00.000Z',
      store: overflowStore as CartStore,
    });

    expect(result.kind).toBe('subtotal_unsafe');
  });
});

// ── 3 & 4. cart-store: findLatestHandoffActionId + findDraftCartBySession ──

describe('cart-store S4 query methods', () => {
  it('findLatestHandoffActionId returns action_id after a successful handoff', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const store = bindCartStore(makeSqlJsHandle(db));
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'findh-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'findh-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');
    const h = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'findh-h',
    });
    if (h.kind !== 'ok') throw new Error('handoff failed');

    const found = store.findLatestHandoffActionId(c.cart_id);
    expect(found).toBe('findh-h');
  });

  it('findLatestHandoffActionId returns undefined for a cart with no handoff', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const store = bindCartStore(makeSqlJsHandle(db));
    const handlers = new CartBridgeHandlers({
      getCurrentSession: makeSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'findh2-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    const found = store.findLatestHandoffActionId(c.cart_id);
    expect(found).toBeUndefined();
  });

  it('findDraftCartBySession returns the active non-terminal cart for a session', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const session = makeSession({ id: 'sess-draft', operator_id: 'cashier-draft' });
    const store = bindCartStore(makeSqlJsHandle(db));
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'draft-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    const draft = store.findDraftCartBySession(session.id);
    expect(draft).toBeDefined();
    if (draft !== undefined) {
      expect(draft.cart_id).toBe(c.cart_id);
      expect(draft.operator_session_id).toBe(session.id);
    }
  });

  it('findDraftCartBySession returns undefined after cart is handed off', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const session = makeSession({ id: 'sess-draft2', operator_id: 'cashier-draft2' });
    const store = bindCartStore(makeSqlJsHandle(db));
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      cartStore: store,
      resolveItemRef: resolver,
    });

    const c = await handlers.create({ idempotency_key: 'draft2-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'draft2-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');
    await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'draft2-h',
    });

    // After handoff, cart is frozen_handed_off — no longer a "draft"
    const draft = store.findDraftCartBySession(session.id);
    expect(draft).toBeUndefined();
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  it('findDraftCartBySession returns undefined for unknown session_id', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const store = bindCartStore(makeSqlJsHandle(db));

    const draft = store.findDraftCartBySession('nonexistent-session');
    expect(draft).toBeUndefined();
  });
});

// ── 5. Envelope builder: discount_placeholders map callback ────────────────

describe('buildPaymentIntentEnvelope with discount placeholders', () => {
  it('envelope includes discount placeholders when cart has them', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const session = makeSession({ id: 'sess-dp-h', operator_id: 'manager-dp', role: 'manager' });
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: resolver,
      // RT-614: the add's audit row is what makes the placeholder trusted.
      auditEmitter: new AuditEmitter(bindAuditEventsStoreDb(makeSqlJsHandle(db))),
    });

    const c = await handlers.create({ idempotency_key: 'dph-c' });
    if (c.kind !== 'ok') throw new Error('create failed');
    const a = await handlers.linesAdd({
      cart_id: c.cart_id,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'dph-a',
    });
    if (a.kind !== 'ok') throw new Error('add failed');

    // RT-608: a manager session applies a discount directly (no threshold).
    const dp = await handlers.discountPlaceholdersAdd({
      cart_id: c.cart_id,
      line_id: a.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'dph-dp',
    });
    if (dp.kind !== 'ok') throw new Error('discount add failed');

    const res = await handlers.handoff({
      cart_id: c.cart_id,
      per_line_versions: [{ line_id: a.line_id, version: 1 }],
      idempotency_key: 'dph-h',
    });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.envelope.discount_placeholders).toHaveLength(1);
      expect(res.envelope.discount_placeholders[0]?.placeholder_kind).toBe('percent_5');
      expect(res.envelope.discount_placeholders[0]?.requires_manager_attribution).toBe(true);
    }
  });
});
