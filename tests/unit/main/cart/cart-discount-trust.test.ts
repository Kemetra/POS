/**
 * RT-614 (RT-608 item 6, option B) — the runtime trust check for manual-
 * discount placeholders.
 *
 * A placeholder is trusted only when a `cart.discount.manager_authorized`
 * audit row names it: same `placeholder_id`, and the same cart, line, tenant
 * and branch. `audit_events` is append-only, and RT-608 writes that row in
 * the add's own transaction, so a placeholder written by any other path
 * (legacy, pre-RT-28, a direct insert) has none.
 *
 *   • the predicate: trusted / no audit row / another `placeholder_id` /
 *     another cart, line, tenant or branch;
 *   • handoff step 3a: a cart holding an untrusted placeholder refuses
 *     `unauthorized_discount` and writes nothing; a manager-authorised one
 *     hands off; the same cart hands off once the untrusted one is removed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import {
  bindDiscountPlaceholderTrust,
  type DiscountPlaceholderRef,
} from '../../../../src/main/cart/discount-trust.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
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

const T0 = '2026-10-17T09:00:00.000Z';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
});

function count(sql: string): unknown {
  return db.exec(sql)[0]?.values[0]?.[0];
}

/** An audit row as RT-608's add writes it, with `payload` overrides. */
function insertAuthorizedAudit(
  payload: Record<string, unknown>,
  scope: { tenant_id?: string; branch_id?: string; action_category?: string } = {},
): void {
  db.run(
    `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
       acting_operator_id, session_id, shift_id, action_category, created_at,
       approving_supervisor_id, payload)
     VALUES (?, ?, ?, 'term-1', 'op-1', 'sess-1', NULL, ?, ?, 'mgr-1', ?)`,
    [
      `evt-${String(Math.random())}`,
      scope.tenant_id ?? 'tenant-1',
      scope.branch_id ?? 'branch-1',
      scope.action_category ?? 'cart.discount.manager_authorized',
      T0,
      JSON.stringify(payload),
    ],
  );
}

/** A placeholder row written by some path other than RT-608's add. */
function insertPlaceholder(
  cart_id: string,
  line_id: string,
  placeholder_id: string,
  attribution: string | null = null,
): void {
  db.run(
    `INSERT INTO cart_line_discount_placeholders (placeholder_id, cart_id, line_id,
       placeholder_kind, requires_manager_attribution, attribution_operator_id, created_at)
     VALUES (?, ?, ?, 'percent_1', 1, ?, ?)`,
    [placeholder_id, cart_id, line_id, attribution, T0],
  );
}

// ── The predicate ───────────────────────────────────────────────────────

describe('bindDiscountPlaceholderTrust (RT-614)', () => {
  const REF: DiscountPlaceholderRef = {
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    cart_id: 'cart-1',
    line_id: 'line-1',
    placeholder_id: 'dp-1',
  };
  const AUDIT = { cart_id: 'cart-1', cart_line_id: 'line-1', placeholder_id: 'dp-1' };

  function trusted(ref: DiscountPlaceholderRef = REF): boolean {
    return bindDiscountPlaceholderTrust(makeSqlJsHandle(db))(ref);
  }

  it('trusts a placeholder named by a manager_authorized audit row', () => {
    insertAuthorizedAudit(AUDIT);
    expect(trusted()).toBe(true);
  });

  it('refuses a placeholder with no audit row', () => {
    expect(trusted()).toBe(false);
  });

  it('refuses when the audit row names a different placeholder_id', () => {
    insertAuthorizedAudit({ ...AUDIT, placeholder_id: 'dp-other' });
    expect(trusted()).toBe(false);
  });

  it('refuses a placeholder whose audit row is for another cart', () => {
    insertAuthorizedAudit({ ...AUDIT, cart_id: 'cart-other' });
    expect(trusted()).toBe(false);
  });

  it('refuses a placeholder whose audit row is for another line', () => {
    insertAuthorizedAudit({ ...AUDIT, cart_line_id: 'line-other' });
    expect(trusted()).toBe(false);
  });

  it.each([
    ['another tenant', { tenant_id: 'tenant-2' }],
    ['another branch', { branch_id: 'branch-2' }],
  ])('refuses a placeholder whose audit row is in %s', (_label, scope) => {
    insertAuthorizedAudit(AUDIT, scope);
    expect(trusted()).toBe(false);
  });

  it('refuses when the only row naming it is another audit category', () => {
    insertAuthorizedAudit(AUDIT, { action_category: 'cart.discount_placeholder.add' });
    expect(trusted()).toBe(false);
  });
});

// ── Handoff step 3a ─────────────────────────────────────────────────────

function session(role: OperatorSessionRecord['role']): OperatorSessionRecord {
  return {
    id: `sess-${role}`,
    operator_id: `op-${role}`,
    display_name: 'Operator',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: T0,
    backend_session_id: 'b',
    last_activity_at: T0,
  };
}

const resolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

describe('cart.handoff refuses an untrusted discount placeholder (RT-614 step 3a)', () => {
  let handlers: CartBridgeHandlers;
  let cartId: string;
  let lineId: string;
  let lineVersion: number;

  beforeEach(async () => {
    const handle = makeSqlJsHandle(db);
    handlers = new CartBridgeHandlers({
      getCurrentSession: () => session('manager'),
      getTerminalId: () => 'term-1',
      cartStore: bindCartStore(handle),
      resolveItemRef: resolver,
      auditEmitter: new AuditEmitter(bindAuditEventsStoreDb(handle)),
      clock: () => new Date(T0),
    });
    const c = await handlers.create({ idempotency_key: 'c-1' });
    if (c.kind !== 'ok') throw new Error('create failed');
    cartId = c.cart_id;
    const a = await handlers.linesAdd({
      cart_id: cartId,
      item_ref: 'SKU-A',
      quantity: 1,
      idempotency_key: 'a-1',
    });
    if (a.kind !== 'ok') throw new Error('add failed');
    lineId = a.line_id;
    lineVersion = a.version;
  });

  function handoff(key = 'h-1') {
    return handlers.handoff({
      cart_id: cartId,
      per_line_versions: [{ line_id: lineId, version: lineVersion }],
      idempotency_key: key,
    });
  }

  function expectNothingWritten(): void {
    expect(count(`SELECT state FROM carts WHERE cart_id = '${cartId}'`)).toBe('editing');
    expect(
      count(
        `SELECT COUNT(*) FROM cart_action_outbox WHERE action_kind = 'cart.handoff_to_payment'`,
      ),
    ).toBe(0);
    expect(
      count(`SELECT COUNT(*) FROM audit_events WHERE action_category = 'cart.handoff_to_payment'`),
    ).toBe(0);
  }

  it('hands off a placeholder the manager authorised through RT-608', async () => {
    const added = await handlers.discountPlaceholdersAdd({
      cart_id: cartId,
      line_id: lineId,
      placeholder_kind: 'percent_1',
      idempotency_key: 'dp-1',
    });
    expect(added.kind).toBe('ok');
    const res = await handoff();
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.envelope.discount_placeholders.map((p) => p.placeholder_id)).toEqual(['dp-1']);
    }
  });

  it('refuses a legacy placeholder with no audit row (null approver)', async () => {
    insertPlaceholder(cartId, lineId, 'dp-legacy');
    expect(await handoff()).toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
    expectNothingWritten();
  });

  it('refuses a legacy placeholder with a renderer-asserted approver', async () => {
    insertPlaceholder(cartId, lineId, 'dp-legacy', 'mgr-asserted');
    expect(await handoff()).toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
    expectNothingWritten();
  });

  it('refuses when the audit row names a different placeholder_id', async () => {
    insertPlaceholder(cartId, lineId, 'dp-legacy', 'mgr-1');
    insertAuthorizedAudit({ cart_id: cartId, cart_line_id: lineId, placeholder_id: 'dp-other' });
    expect(await handoff()).toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
    expectNothingWritten();
  });

  it('refuses a placeholder whose authorisation belongs to another cart', async () => {
    insertPlaceholder(cartId, lineId, 'dp-moved', 'mgr-1');
    insertAuthorizedAudit({
      cart_id: 'cart-other',
      cart_line_id: lineId,
      placeholder_id: 'dp-moved',
    });
    expect(await handoff()).toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
    expectNothingWritten();
  });

  it('refuses a mixed cart: one trusted and one untrusted placeholder', async () => {
    await handlers.discountPlaceholdersAdd({
      cart_id: cartId,
      line_id: lineId,
      placeholder_kind: 'percent_1',
      idempotency_key: 'dp-1',
    });
    insertPlaceholder(cartId, lineId, 'dp-legacy');
    expect(await handoff()).toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
    expectNothingWritten();
  });

  it('hands off the same cart once the untrusted placeholder is removed', async () => {
    insertPlaceholder(cartId, lineId, 'dp-legacy');
    expect(await handoff('h-1')).toEqual({ kind: 'refused', reason: 'unauthorized_discount' });
    const removed = await handlers.discountPlaceholdersRemove({
      cart_id: cartId,
      placeholder_id: 'dp-legacy',
      idempotency_key: 'dp-rm-1',
    });
    expect(removed.kind).toBe('ok');
    expect((await handoff('h-2')).kind).toBe('ok');
  });
});
