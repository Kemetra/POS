/**
 * RT-352 (RT-116 S4a, RT-115 D3.2) — a draft cart outlives its session.
 *
 * Runs the real cart migrations (0008 → 0046) on sql.js and the real
 * SessionManager. A "restart" is a fresh SessionManager + service on the same
 * database: no `onEnded` fires, so re-attach at sign-in must be lazy.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import {
  createHeldCarts,
  registerHeldCartLifecycle,
  type HeldCarts,
} from '../../../../src/main/cart/held-carts.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0046_carts_owner_key_index.sql',
].map((f) => readFileSync(path.resolve(__dirname0, '../../../../migrations', f), 'utf8'));

const TERMINAL = 'terminal-a';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

interface Terminal {
  sessions: SessionManager;
  held: HeldCarts;
  emit: ReturnType<typeof vi.fn>;
}

let db: SqlJsDatabase;
let terminalId: string | null;

function bootTerminal(): Terminal {
  const handle = makeSqlJsHandle(db);
  const emit = vi.fn();
  const sessions = new SessionManager();
  const held = createHeldCarts({
    db: handle,
    cartStore: bindCartStore(handle),
    auditEmitter: { emit },
    resolveTerminalId: () => terminalId,
    clock: () => new Date('2026-10-10T12:00:00.000Z'),
  });
  registerHeldCartLifecycle({ sessionManager: sessions, heldCarts: held });
  return { sessions, held, emit };
}

function signIn(
  t: Terminal,
  operator_id: string,
  scope: { tenant_id?: string; branch_id?: string } = {},
): OperatorSessionRecord {
  return t.sessions.create({
    operator_id,
    display_name: operator_id,
    role: 'cashier',
    tenant_id: scope.tenant_id ?? 'tenant-1',
    branch_id: scope.branch_id ?? 'branch-1',
    backend_session_id: '',
  });
}

type SeedState = 'empty' | 'editing' | 'discount_pending_attribution' | 'frozen_handed_off';

async function openCart(t: Terminal, state: SeedState): Promise<string> {
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => t.sessions.getCurrent(),
    getTerminalId: () => terminalId,
    cartStore: bindCartStore(makeSqlJsHandle(db)),
  });
  const res = await handlers.create({ idempotency_key: crypto.randomUUID() });
  if (res.kind !== 'ok') throw new Error('cart.create refused');
  db.run(`UPDATE carts SET state = ? WHERE cart_id = ?`, [state, res.cart_id]);
  return res.cart_id;
}

function cartRow(cart_id: string): { state: string; operator_session_id: string } {
  const stmt = db.prepare('SELECT state, operator_session_id FROM carts WHERE cart_id = ?');
  stmt.bind([cart_id]);
  stmt.step();
  const row = stmt.getAsObject() as { state: string; operator_session_id: string };
  stmt.free();
  return row;
}

function categories(t: Terminal): string[] {
  return t.emit.mock.calls.map((c) => (c[0] as AuditEvent).action_category);
}

beforeEach(() => {
  db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  terminalId = TERMINAL;
});

describe('RT-352 — held draft cart re-attaches for its owner', () => {
  it('re-attaches the draft after sign-out → sign-in by the same cashier', async () => {
    const t = bootTerminal();
    const first = signIn(t, 'cashier-1');
    const cart = await openCart(t, 'editing');
    t.sessions.end('signed_out');

    const second = signIn(t, 'cashier-1');

    expect(cartRow(cart)).toEqual({ state: 'editing', operator_session_id: second.id });
    expect(t.held.getResumeState(second)).toEqual({
      cart_id: cart,
      payment_attempt_id: null,
      other_held_cart_count: 0,
    });
    const reattached = t.emit.mock.calls
      .map((c) => c[0] as AuditEvent)
      .find((e) => e.action_category === 'cart.reattached');
    expect(reattached?.payload).toEqual({
      cart_id: cart,
      from_operator_session_id: first.id,
      to_operator_session_id: second.id,
    });
    expect(reattached?.originating_terminal_id).toBe(TERMINAL);
  });

  it('re-attaches after an app restart (no onEnded ever fired)', async () => {
    const before = bootTerminal();
    signIn(before, 'cashier-1');
    const cart = await openCart(before, 'discount_pending_attribution');

    const after = bootTerminal(); // restart: fresh in-memory session manager
    const session = signIn(after, 'cashier-1');

    expect(cartRow(cart).operator_session_id).toBe(session.id);
    expect(categories(after)).toEqual(['cart.reattached']);
  });

  it('lets the re-attached owner mutate the cart through the unchanged ownership check', async () => {
    const t = bootTerminal();
    signIn(t, 'cashier-1');
    const cart = await openCart(t, 'editing');
    t.sessions.end('signed_out');
    signIn(t, 'cashier-1');

    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => t.sessions.getCurrent(),
      getTerminalId: () => terminalId,
      cartStore: bindCartStore(makeSqlJsHandle(db)),
    });
    const voided = await handlers.void({ cart_id: cart, idempotency_key: 'void-1' });
    expect(voided.kind).toBe('ok');
  });

  it.each([
    { name: 'a different cashier on the same terminal', operator: 'cashier-2', terminal: TERMINAL },
    { name: 'the same cashier on another terminal', operator: 'cashier-1', terminal: 'terminal-b' },
    { name: 'the same cashier in another tenant', operator: 'cashier-1', tenant_id: 'tenant-2' },
    { name: 'the same cashier in another branch', operator: 'cashier-1', branch_id: 'branch-2' },
  ])('never re-attaches the draft for $name', async (row) => {
    const t = bootTerminal();
    const owner = signIn(t, 'cashier-1');
    const cart = await openCart(t, 'editing');
    t.sessions.end('signed_out');
    terminalId = row.terminal ?? TERMINAL;

    const other = signIn(t, row.operator, row);

    expect(cartRow(cart).operator_session_id).toBe(owner.id);
    expect(t.held.getResumeState(other)).toEqual({
      cart_id: null,
      payment_attempt_id: null,
      other_held_cart_count: 0,
    });
  });

  it('re-attaches only the newest draft and counts the rest', async () => {
    const t = bootTerminal();
    signIn(t, 'cashier-1');
    const older = await openCart(t, 'editing');
    db.run(
      `UPDATE carts SET created_at = '2026-01-01T00:00:00.000Z', operator_session_id = 'dead-1'
        WHERE cart_id = ?`,
      [older],
    );
    const newer = await openCart(t, 'editing');
    t.sessions.end('signed_out');

    const session = signIn(t, 'cashier-1');

    expect(cartRow(newer).operator_session_id).toBe(session.id);
    expect(cartRow(older).operator_session_id).toBe('dead-1');
    expect(t.held.getResumeState(session)).toMatchObject({
      cart_id: newer,
      other_held_cart_count: 1,
    });
  });

  it('leaves a frozen (handed-off or settled) cart untouched at end and sign-in', async () => {
    const t = bootTerminal();
    const owner = signIn(t, 'cashier-1');
    const cart = await openCart(t, 'frozen_handed_off');
    t.sessions.end('signed_out');
    const session = signIn(t, 'cashier-1');

    expect(cartRow(cart)).toEqual({ state: 'frozen_handed_off', operator_session_id: owner.id });
    expect(t.held.getResumeState(session).cart_id).toBeNull();
    expect(t.emit).not.toHaveBeenCalled();
  });

  it('does nothing on an unpaired terminal', async () => {
    const t = bootTerminal();
    const owner = signIn(t, 'cashier-1');
    const cart = await openCart(t, 'editing');
    t.sessions.end('signed_out');
    terminalId = null;

    const session = signIn(t, 'cashier-1');

    expect(cartRow(cart).operator_session_id).toBe(owner.id);
    expect(t.held.getResumeState(session).other_held_cart_count).toBe(0);
  });

  it('reports nothing to resume when signed out', () => {
    expect(bootTerminal().held.getResumeState(null)).toEqual({
      cart_id: null,
      payment_attempt_id: null,
      other_held_cart_count: 0,
    });
  });
});

describe('RT-352 — session end', () => {
  it('holds a draft and audits cart.held_on_session_end with the end cause', async () => {
    const t = bootTerminal();
    const owner = signIn(t, 'cashier-1');
    const cart = await openCart(t, 'editing');

    t.sessions.end('superseded_by_takeover');

    expect(cartRow(cart).state).toBe('editing');
    const event = t.emit.mock.calls[0]?.[0] as AuditEvent;
    expect(event.action_category).toBe('cart.held_on_session_end');
    expect(event.payload).toEqual({
      cart_id: cart,
      operator_session_id: owner.id,
      end_cause: 'superseded_by_takeover',
    });
    expect(event.acting_operator_id).toBe('cashier-1');
  });

  it('records a null end cause when the session ended without one', async () => {
    const t = bootTerminal();
    signIn(t, 'cashier-1');
    await openCart(t, 'editing');
    t.sessions.end();
    expect((t.emit.mock.calls[0]?.[0] as AuditEvent).payload['end_cause']).toBeNull();
  });

  it.each([
    { name: 'at session end', restart: false },
    { name: 'lazily at the next sign-in after a restart', restart: true },
  ])('closes an empty cart $name, without audit', async ({ restart }) => {
    const t = bootTerminal();
    signIn(t, 'cashier-1');
    const cart = await openCart(t, 'empty');
    const next = restart ? bootTerminal() : t;
    if (!restart) t.sessions.end('signed_out');
    signIn(next, 'cashier-1');

    expect(cartRow(cart).state).toBe('cancelled');
    expect(categories(next)).toEqual([]);
  });
});

describe('RT-352 — registerHeldCartLifecycle', () => {
  it('logs and swallows a failure so sign-in and sign-out still complete', () => {
    const sessions = new SessionManager();
    const logger = { error: vi.fn() };
    const failing: HeldCarts = {
      reattachOnSignIn: () => {
        throw new Error('boom');
      },
      holdOnSessionEnd: () => {
        throw new Error('boom');
      },
      getResumeState: () => ({ cart_id: null, payment_attempt_id: null, other_held_cart_count: 0 }),
    };
    registerHeldCartLifecycle({ sessionManager: sessions, heldCarts: failing, logger });

    expect(() => signIn({ sessions } as Terminal, 'cashier-1')).not.toThrow();
    expect(sessions.end('signed_out')).not.toBeNull();
    expect(logger.error.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual([
      'held_cart.reattach.failed',
      'held_cart.hold.failed',
    ]);
  });
});
