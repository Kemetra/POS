/**
 * T057 — cart.void post-handoff: manager-attributed cancel (S3 contract).
 *
 * `cart.cancel.post_handoff` is the manager-attributed action that cancels a
 * cart already in `frozen_handed_off` state (spec FR-033). This is a DISTINCT
 * bridge action from `cart.void`; the void path always refuses 'frozen'.
 *
 * S3 contract for the `void` call WITH `attribution_operator_id` set on a
 * frozen cart — the gate sees 'frozen' and refuses, confirming that the
 * caller must use the future `cart.cancelPostHandoff` bridge method, not
 * `cart.void`.
 *
 * Additionally, this test expresses the S3 audit-emission contract for
 * `cart.cancel.post_handoff`: when that handler is implemented (T068), it
 * MUST emit an audit event with the correct category and mandatory attributes.
 *
 * Tests that assert { kind: 'ok' } are RED until T068.
 * The 'frozen' refusal on void is GREEN (S2 live).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

// vi.mock patches AuditEmitter before the module resolves — the cart-bridge
// handler (T068) will call new AuditEmitter(store).emit(event). The spy
// captures that call so we can assert the event shape without a real DB
// audit_events table in scope.
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

function makeManagerSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-mgr-t057',
    operator_id: 'mgr-1',
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

function makeCashierSession(overrides?: Partial<OperatorSessionRecord>): OperatorSessionRecord {
  return {
    id: 'sess-cashier-t057',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-16T08:00:00.000Z',
    backend_session_id: 'b-cash-1',
    last_activity_at: '2026-05-16T08:00:00.000Z',
    ...overrides,
  };
}

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  emitFn: ReturnType<typeof vi.fn>;
  cart_id: string;
  cashierSession: OperatorSessionRecord;
  managerSession: OperatorSessionRecord;
}

async function newFrozenCart(): Promise<Fixture> {
  const cashierSession = makeCashierSession();
  const managerSession = makeManagerSession();

  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handle = makeSqlJsHandle(db);
  const store = bindCartStore(handle);

  // Cashier creates the cart.
  const cashierHandlers = new CartBridgeHandlers({
    getCurrentSession: () => cashierSession,
    getTerminalId: () => 'terminal-test-380',
    cartStore: store,
    clock: () => new Date('2026-05-16T10:00:00.000Z'),
  });
  const createRes = await cashierHandlers.create({ idempotency_key: 'create-t057' });
  if (createRes.kind !== 'ok') throw new Error('create failed');

  // Manager is the active session for cancel.
  const emitFn = vi.fn();
  const auditEmitter = { emit: emitFn } as unknown as AuditEmitter;
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => managerSession,
    getTerminalId: () => 'terminal-test-380',
    cartStore: store,
    clock: () => new Date('2026-05-16T10:05:00.000Z'),
    auditEmitter,
    // Contract since the §A4 review: cancel fails closed without the payments record.
    cartPaymentStatus: () => 'none',
  });

  // Simulate frozen_handed_off with a prior handoff_action_id in outbox.
  db.run(`UPDATE carts SET state = 'frozen_handed_off' WHERE cart_id = ?`, [createRes.cart_id]);
  db.run(
    `INSERT INTO cart_action_outbox
       (action_id, cart_id, line_id, action_kind, acting_operator_id,
        attribution_operator_id, operator_session_id, payload_json, applied_at)
     VALUES (?, ?, NULL, 'cart.handoff_to_payment', ?, NULL, ?, '{}', ?)`,
    [
      'handoff-action-t057',
      createRes.cart_id,
      cashierSession.operator_id,
      cashierSession.id,
      '2026-05-16T10:02:00.000Z',
    ],
  );

  return {
    db,
    handlers,
    emitFn,
    cart_id: createRes.cart_id,
    cashierSession,
    managerSession,
  };
}

function readOutboxKinds(db: SqlJsDatabase, cart_id: string): string[] {
  const stmt = db.prepare(
    'SELECT action_kind FROM cart_action_outbox WHERE cart_id = ? ORDER BY applied_at',
  );
  stmt.bind([cart_id]);
  const kinds: string[] = [];
  while (stmt.step()) kinds.push(stmt.getAsObject()['action_kind'] as string);
  stmt.free();
  return kinds;
}

// ── S2-live gate confirmation ──────────────────────────────────────────────

describe('cart.void on frozen cart — always refused (S2 live — GREEN)', () => {
  it('refuses void even with attribution_operator_id — post-handoff cancel is a separate action', async () => {
    const f = await newFrozenCart();
    const res = await f.handlers.void({
      cart_id: f.cart_id,
      attribution_operator_id: f.managerSession.operator_id,
      idempotency_key: 'void-frozen-mgr-attr',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('frozen');
  });
});

// ── S3 contract: cart.cancelPostHandoff (T057 — RED until T068) ───────────

type CancelPostHandoffReq = {
  cart_id: string;
  handoff_action_id: string;
  attribution_operator_id?: string;
  idempotency_key: string;
};
type CancelPostHandoffRes = { kind: 'ok' } | { kind: 'refused'; reason: string };
interface WithCancelPostHandoff {
  cancelPostHandoff(req: CancelPostHandoffReq): Promise<CancelPostHandoffRes>;
}

function hasCancelPostHandoff(
  h: CartBridgeHandlers,
): h is CartBridgeHandlers & WithCancelPostHandoff {
  return typeof (h as unknown as WithCancelPostHandoff).cancelPostHandoff === 'function';
}

function callCancel(
  h: CartBridgeHandlers & WithCancelPostHandoff,
  req: CancelPostHandoffReq,
): Promise<CancelPostHandoffRes> {
  return h.cancelPostHandoff(req);
}

describe('cart.cancelPostHandoff — manager-attributed cancel S3 contract (RED until T068)', () => {
  let f: Fixture;

  beforeEach(async () => {
    vi.clearAllMocks();
    f = await newFrozenCart();
  });

  it('returns { kind: ok } when manager provides attribution', async () => {
    if (!hasCancelPostHandoff(f.handlers)) {
      expect(true).toBe(false); // Always fails until T068 adds the method.
      return;
    }
    const res = await callCancel(f.handlers, {
      cart_id: f.cart_id,
      handoff_action_id: 'handoff-action-t057',
      attribution_operator_id: f.managerSession.operator_id,
      idempotency_key: 'cancel-posthandoff-t057',
    });
    expect(res.kind).toBe('ok');
  });

  it('transitions cart state to cancelled', async () => {
    if (!hasCancelPostHandoff(f.handlers)) {
      expect(true).toBe(false);
      return;
    }
    await callCancel(f.handlers, {
      cart_id: f.cart_id,
      handoff_action_id: 'handoff-action-t057',
      attribution_operator_id: f.managerSession.operator_id,
      idempotency_key: 'cancel-posthandoff-t057-b',
    });
    const stmt = f.db.prepare('SELECT state FROM carts WHERE cart_id = ?');
    stmt.bind([f.cart_id]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    expect(row?.['state']).toBe('cancelled');
  });

  it('writes a cart.cancel.post_handoff outbox row', async () => {
    if (!hasCancelPostHandoff(f.handlers)) {
      expect(true).toBe(false);
      return;
    }
    await callCancel(f.handlers, {
      cart_id: f.cart_id,
      handoff_action_id: 'handoff-action-t057',
      attribution_operator_id: f.managerSession.operator_id,
      idempotency_key: 'cancel-posthandoff-t057-c',
    });
    expect(readOutboxKinds(f.db, f.cart_id)).toContain('cart.cancel.post_handoff');
  });

  it('emits audit event with category cart.cancel.post_handoff and FR-025 attributes', async () => {
    if (!hasCancelPostHandoff(f.handlers)) {
      expect(true).toBe(false);
      return;
    }
    await callCancel(f.handlers, {
      cart_id: f.cart_id,
      handoff_action_id: 'handoff-action-t057',
      attribution_operator_id: f.managerSession.operator_id,
      idempotency_key: 'cancel-posthandoff-t057-d',
    });
    expect(f.emitFn).toHaveBeenCalledOnce();
    const emittedEvent = f.emitFn.mock.calls[0][0] as AuditEvent;
    expect(emittedEvent.action_category).toBe('cart.cancel.post_handoff');
    // Cashier is acting_operator (requester); manager is approving_supervisor.
    expect(emittedEvent.acting_operator_id).toBe(f.cashierSession.operator_id);
    expect(emittedEvent.approving_supervisor_id).toBe(f.managerSession.operator_id);
    // FR-025 mandatory attributes must be present.
    expect(emittedEvent.acting_operator_id).toBeTruthy();
    expect(emittedEvent.originating_terminal_id).toBeTruthy();
    expect(emittedEvent.created_at).toBeTruthy();
    expect(emittedEvent.action_category).toBeTruthy();
    // shift_id is nullable for non-shift-scoped categories per data-model.md,
    // but the key must be present (FR-025 checks presence, not truthiness).
    expect('shift_id' in emittedEvent).toBe(true);
    // Payload must carry cart_id and the original handoff_action_id.
    expect(emittedEvent.payload['cart_id']).toBe(f.cart_id);
    expect(emittedEvent.payload['handoff_action_id']).toBe('handoff-action-t057');
  });

  it('refuses without manager attribution (cashier cannot cancel post-handoff)', async () => {
    if (!hasCancelPostHandoff(f.handlers)) {
      expect(true).toBe(false);
      return;
    }
    // Cashier session — no attribution.
    const cashierHandlers = new CartBridgeHandlers({
      getCurrentSession: () => f.cashierSession,
      getTerminalId: () => 'terminal-test-380',
      cartStore: bindCartStore(makeSqlJsHandle(f.db)),
    });
    if (!hasCancelPostHandoff(cashierHandlers)) {
      expect(true).toBe(false);
      return;
    }
    const res = await callCancel(cashierHandlers, {
      cart_id: f.cart_id,
      handoff_action_id: 'handoff-action-t057',
      idempotency_key: 'cancel-no-attr',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('manager_attribution_required');
  });

  it('refuses with reason closed when cart is not in frozen_handed_off state', async () => {
    if (!hasCancelPostHandoff(f.handlers)) {
      expect(true).toBe(false);
      return;
    }
    f.db.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [f.cart_id]);
    const res = await callCancel(f.handlers, {
      cart_id: f.cart_id,
      handoff_action_id: 'handoff-action-t057',
      idempotency_key: 'cancel-not-frozen',
    });
    expect(res.kind).toBe('refused');
    if (res.kind === 'refused') expect(res.reason).toBe('closed');
  });
});
