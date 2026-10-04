/**
 * T061 — cart.discountPlaceholders.add above threshold WITH manager
 *        attribution + audit emission (S3 contract).
 *
 * RT-183: the approver is never renderer-supplied. Manager attribution comes
 * from the authenticated session: a manager (or admin) session approves its
 * own above-threshold discount (RT-28 D2). The handler MUST:
 *   1. Insert a `cart_line_discount_placeholders` row naming the session
 *      manager as `attribution_operator_id`.
 *   2. Write an outbox row.
 *   3. Return `{ kind: 'ok', placeholder_id, requires_manager_attribution: true }`.
 *   4. Emit audit event with category `cart.discount.above_threshold`.
 *
 * The session manager is both `acting_operator_id` and
 * `approving_supervisor_id` on the audit event envelope. The cashier-session
 * refusal (including a renderer-supplied supervisor id) is covered by T060
 * and `cart-discount-add-no-renderer-supervisor.test.ts`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

vi.mock('../../../../src/main/audit/audit-emitter.js');

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
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

const MANAGER_ID = 'mgr-1';

function makeManagerSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-manager-t061',
    operator_id: MANAGER_ID,
    display_name: 'Manager One',
    role: 'manager',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-16T08:00:00.000Z',
    backend_session_id: 'b-mgr-1',
    last_activity_at: '2026-05-16T08:00:00.000Z',
    ...overrides,
  };
}

const fixtureResolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  emitFn: ReturnType<typeof vi.fn>;
  cart_id: string;
  line_id: string;
  managerSession: OperatorSessionRecord;
}

async function newCartWithLine(): Promise<Fixture> {
  const managerSession = makeManagerSession();
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);
  const emitFn = vi.fn();
  const auditEmitter = { emit: emitFn } as unknown as AuditEmitter;
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => managerSession,
    getTerminalId: () => 'terminal-test-380',
    cartStore: store,
    resolveItemRef: fixtureResolver,
    clock: () => new Date('2026-05-16T10:00:00.000Z'),
    auditEmitter,
  });

  const createRes = await handlers.create({ idempotency_key: 'create-t061' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  const addRes = await handlers.linesAdd({
    cart_id: createRes.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'add-t061',
  });
  if (addRes.kind !== 'ok') throw new Error('linesAdd failed');

  return {
    db,
    handlers,
    emitFn,
    cart_id: createRes.cart_id,
    line_id: addRes.line_id,
    managerSession,
  };
}

function readDiscountPlaceholders(db: SqlJsDatabase, cart_id: string): Record<string, unknown>[] {
  const stmt = db.prepare('SELECT * FROM cart_line_discount_placeholders WHERE cart_id = ?');
  stmt.bind([cart_id]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── S3 contract: above-threshold WITH attribution (T061 — RED until T069+T070) ─

describe('cart.discountPlaceholders.add — above-threshold with manager attribution (RED until T069+T070)', () => {
  let f: Fixture;

  beforeEach(async () => {
    vi.clearAllMocks();
    f = await newCartWithLine();
  });

  it('returns ok with requires_manager_attribution: true', async () => {
    const res = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-a',
    });
    // RED until T069.
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.requires_manager_attribution).toBe(true);
      expect(typeof res.placeholder_id).toBe('string');
    }
  });

  it('inserts a cart_line_discount_placeholders row', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-b',
    });
    // RED until T069.
    const rows = readDiscountPlaceholders(f.db, f.cart_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['placeholder_kind']).toBe('percent_20');
    expect(rows[0]?.['line_id']).toBe(f.line_id);
    expect(rows[0]?.['attribution_operator_id']).toBe(MANAGER_ID);
  });

  it('emits audit event with category cart.discount.above_threshold', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-c',
    });
    // RED until T070.
    expect(f.emitFn).toHaveBeenCalledOnce();
    const emittedEvent = f.emitFn.mock.calls[0][0] as AuditEvent;
    expect(emittedEvent.action_category).toBe('cart.discount.above_threshold');
  });

  it('audit event names the session manager as acting_operator and approving_supervisor', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-d',
    });
    // RED until T070.
    const emittedEvent = f.emitFn.mock.calls[0][0] as AuditEvent;
    expect(emittedEvent.acting_operator_id).toBe(f.managerSession.operator_id);
    expect(emittedEvent.approving_supervisor_id).toBe(MANAGER_ID);
  });

  it('audit event payload carries cart_id and cart_line_id', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-e',
    });
    // RED until T070.
    const emittedEvent = f.emitFn.mock.calls[0][0] as AuditEvent;
    expect(emittedEvent.payload['cart_id']).toBe(f.cart_id);
    expect(emittedEvent.payload['cart_line_id']).toBe(f.line_id);
  });

  it('audit event satisfies FR-025 mandatory attributes', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-f',
    });
    // RED until T070.
    const emittedEvent = f.emitFn.mock.calls[0][0] as AuditEvent;
    expect(emittedEvent.acting_operator_id).toBeTruthy();
    expect(emittedEvent.originating_terminal_id).toBeTruthy();
    expect(emittedEvent.created_at).toBeTruthy();
    expect(emittedEvent.action_category).toBeTruthy();
    expect('shift_id' in emittedEvent).toBe(true);
  });

  it('audit payload does not contain forbidden keys', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-g',
    });
    // RED until T070.
    const emittedEvent = f.emitFn.mock.calls[0][0] as AuditEvent;
    const forbiddenKeys = ['pin', 'password', 'clerk_jwt', 'device_token', 'token', 'secret'];
    for (const key of forbiddenKeys) {
      expect(key in emittedEvent.payload).toBe(false);
    }
  });

  it('is idempotent — same idempotency_key returns ok and emits only once', async () => {
    await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-h',
    });
    const res2 = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: 'dp-t061-h', // same key
    });
    // RED until T069 — idempotent replay should succeed and not emit twice.
    expect(res2.kind).toBe('ok');
    // Audit emitter should fire only once (not on replay).
    expect(f.emitFn).toHaveBeenCalledOnce();
  });

  it('Fix 2 regression — rejects a remove idempotency key replayed as add', async () => {
    // A .remove outbox row must not be accepted as a valid replay for .add.
    // The fix changes startsWith('cart.discount_placeholder') → exact match
    // '=== cart.discount_placeholder.add' to prevent cross-action key reuse.
    const SHARED_KEY = 'dp-t061-cross-action';
    // Seed a remove action in the outbox under SHARED_KEY.
    f.db.run(
      `INSERT INTO cart_action_outbox
         (action_id, cart_id, line_id, action_kind, acting_operator_id,
          attribution_operator_id, operator_session_id, payload_json, applied_at)
       VALUES (?, ?, NULL, 'cart.discount_placeholder.remove', ?, NULL, ?, '{}', ?)`,
      [SHARED_KEY, f.cart_id, MANAGER_ID, 'sess-manager-t061', '2026-05-16T10:01:00.000Z'],
    );
    const res = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_20',
      idempotency_key: SHARED_KEY,
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('idempotency_payload_mismatch');
  });
});
