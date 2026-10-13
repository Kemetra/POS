/**
 * RT-442 (RT-116 S5) — no session end ever reverses tender.
 *
 * The real payment FSMs, start / apply handlers, repositories and the held-cart
 * lifecycle over an in-memory SQLite database with every migration. A
 * "restart" is a new SessionManager and lifecycle on the same database: no
 * `onEnded` fires, and nothing may run until the next admitted sign-in (§6).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import {
  bindAttemptHasLiveTender,
  bindPaymentAttemptsRepository,
} from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../../src/main/payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from '../../../../src/main/payments/idempotency.js';
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import {
  createPaymentAuditEmitter,
  type PaymentAuditEvent,
} from '../../../../src/main/payments/audit-emitter.js';
import { createHeldAttempts } from '../../../../src/main/payments/held-attempts.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import {
  createHeldCarts,
  registerHeldCartLifecycle,
} from '../../../../src/main/cart/held-carts.js';
import {
  SessionManager,
  type OperatorSessionRecord,
} from '../../../../src/main/operator/session-manager.js';
import { resolveSessionScope } from '../../../../src/main/operator/resolve-session-scope.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { SessionEndCause } from '../../../../src/shared/operator/session-end-cause.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.resolve(dir, '..', '..', '..', '..', 'migrations');
const MIGRATIONS = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATION_DIR, f), 'utf8'));

const TERMINAL = 'terminal-1';
const OWNER = 'op-owner';
const OTHER = 'op-other';
const NOW = '2026-10-13T10:00:00.000Z';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
});

/** One running app process on the terminal. */
function boot() {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const tenderLineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  const paymentAttemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const paymentAudit: PaymentAuditEvent[] = [];
  const cartAudit: AuditEvent[] = [];
  const paymentAuditEmitter = createPaymentAuditEmitter({
    sink: { write: (event) => paymentAudit.push(event) },
  });
  const sessions = new SessionManager();
  let n = 0;
  const uuid = (): string => `uuid-${String(++n)}-${Math.random().toString(36).slice(2)}`;
  const clock = (): Date => new Date(NOW);
  const held = createHeldCarts({
    db: handle,
    cartStore: bindCartStore(handle),
    auditEmitter: { emit: (event) => cartAudit.push(event) },
    resolveTerminalId: () => TERMINAL,
    attempts: createHeldAttempts({
      db: handle,
      paymentAttemptFsm,
      auditEmitter: paymentAuditEmitter,
      uuid,
      clock,
    }),
    clock,
  });
  registerHeldCartLifecycle({ sessionManager: sessions, heldCarts: held });
  const shared = {
    getCurrentSession: () => resolveSessionScope(sessions.getCurrent(), TERMINAL),
    attemptsRepo: attempts,
    idempotency: createIdempotencyHelper({ outbox }),
    auditEmitter: paymentAuditEmitter,
    clock,
  };
  return {
    sessions,
    held,
    paymentAudit,
    cartAudit,
    paymentAttemptFsm,
    start: createPaymentsStartHandler({
      ...shared,
      paymentAttemptFsm,
      uuid,
      checkCartForPayment: () => ({ kind: 'ok' }),
      attemptHasLiveTender: bindAttemptHasLiveTender(handle),
    }),
    apply: createTenderApplyHandler({ ...shared, linesRepo: lines, tenderLineFsm, uuid }),
  };
}
type App = ReturnType<typeof boot>;

function signIn(app: App, operator_id: string): OperatorSessionRecord {
  return app.sessions.create({
    operator_id,
    display_name: operator_id,
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    backend_session_id: '',
  });
}

/** A handed-off cart of the current session (as cart.handoff leaves it). */
function frozenCart(session: OperatorSessionRecord, cart_id: string, subtotal = 15_000): string {
  db.run(
    `INSERT INTO carts (cart_id, tenant_id, branch_id, terminal_id, owning_operator_id,
       operator_session_id, state, cart_subtotal_minor, handoff_envelope_json, created_at, updated_at)
     VALUES (?, 'tenant-1', 'branch-1', ?, ?, ?, 'frozen_handed_off', ?, ?, ?, ?)`,
    [
      cart_id,
      TERMINAL,
      session.operator_id,
      session.id,
      subtotal,
      JSON.stringify({ handoff_action_id: `h-${cart_id}`, lines: [], discount_placeholders: [] }),
      NOW,
      NOW,
    ],
  );
  return cart_id;
}

function envelope(cart_id: string, subtotal = 15_000) {
  return {
    envelope_handoff_action_id: `h-${cart_id}`,
    envelope_cart_id: cart_id,
    envelope_subtotal_minor: subtotal,
    envelope_version: 'v1' as const,
  };
}

async function start(app: App, cart_id: string, key = crypto.randomUUID()): Promise<string> {
  const r = await app.start({ ...envelope(cart_id), idempotency_key: key });
  if (r.kind !== 'ok') throw new Error(`start refused: ${r.reason}`);
  return r.payment_attempt_id;
}

async function payCash(app: App, attempt: string, amount: number): Promise<void> {
  const r = await app.apply({
    payment_attempt_id: attempt,
    tender_type: 'cash',
    amount_applied_minor: amount,
    idempotency_key: crypto.randomUUID(),
  });
  if (r.kind !== 'ok') throw new Error(`apply refused: ${r.reason}`);
}

function one(sql: string, params: unknown[]): Record<string, unknown> {
  const stmt = db.prepare(sql);
  stmt.bind(params as never);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  return row;
}

const attemptRow = (id: string) =>
  one('SELECT state, operator_session_id FROM payment_attempts WHERE payment_attempt_id = ?', [id]);
const lineStates = (id: string): unknown[] =>
  db
    .exec('SELECT state FROM payment_tender_lines WHERE payment_attempt_id = ?', [id])[0]
    ?.values.map((v) => v[0]) ?? [];
const cartSession = (cart_id: string) =>
  one('SELECT operator_session_id FROM carts WHERE cart_id = ?', [cart_id])['operator_session_id'];
const categories = (events: { action_category: string }[]) => events.map((e) => e.action_category);

/** The owner mid-payment: a frozen cart with 5,000 of 15,000 paid in cash. */
async function midPayment(app: App) {
  const owner = signIn(app, OWNER);
  const cart = frozenCart(owner, 'cart-1');
  const attempt = await start(app, cart);
  await payCash(app, attempt, 5_000);
  return { owner, cart, attempt };
}

describe('RT-442 — no end cause ever reverses tender', () => {
  it.each<SessionEndCause | undefined>([
    undefined, // explicit sign-out
    'superseded_by_takeover',
    'account_disabled_mid_session',
    'terminal_session_terminated',
    'superseded_at_lock',
  ])(
    'end cause %s: the line stays applied, the attempt stays started and is held',
    async (cause) => {
      const app = boot();
      const { attempt, cart } = await midPayment(app);

      app.sessions.end(cause);

      expect(attemptRow(attempt).state).toBe('started');
      expect(lineStates(attempt)).toEqual(['applied']);
      expect(categories(app.paymentAudit)).not.toContain('tender.reversed');
      const held = app.paymentAudit.find(
        (e) => e.action_category === 'payment.held_on_session_end',
      );
      expect(held?.payload).toEqual({
        payment_attempt_id: attempt,
        cart_id: cart,
        end_cause: cause ?? null,
        tender: [{ tender_type: 'cash', amount_applied_minor: 5_000, state: 'applied' }],
      });
      expect(categories(app.cartAudit)).toContain('cart.held_on_session_end');
    },
  );

  it('a restart changes nothing at boot; the stuck attempt waits for its owner', async () => {
    const first = boot();
    const { attempt, cart, owner } = await midPayment(first);

    const app = boot(); // restart: no onEnded, nothing runs
    expect(attemptRow(attempt)).toEqual({ state: 'started', operator_session_id: owner.id });
    expect(lineStates(attempt)).toEqual(['applied']);
    expect(app.paymentAudit).toEqual([]);

    const back = signIn(app, OWNER);
    expect(attemptRow(attempt)).toEqual({ state: 'started', operator_session_id: back.id });
    expect(cartSession(cart)).toBe(back.id);
    expect(lineStates(attempt)).toEqual(['applied']);
    expect(app.held.getResumeState(back)).toEqual({
      cart_id: cart,
      payment_attempt_id: attempt,
      other_held_cart_count: 0,
    });
    const reattached = app.paymentAudit.find((e) => e.action_category === 'payment.reattached');
    expect(reattached?.payload).toEqual({
      payment_attempt_id: attempt,
      cart_id: cart,
      from_operator_session_id: owner.id,
      to_operator_session_id: back.id,
    });
  });

  it('re-attaches for its owner only', async () => {
    const app = boot();
    const { attempt, owner } = await midPayment(app);
    app.sessions.end();

    const other = signIn(app, OTHER);
    expect(attemptRow(attempt).operator_session_id).toBe(owner.id);
    expect(app.held.getResumeState(other).payment_attempt_id).toBeNull();
    expect(categories(app.paymentAudit)).not.toContain('payment.reattached');
  });

  it('the owner resumes Checkout on the same attempt; its tender is still there', async () => {
    const app = boot();
    const { attempt, cart } = await midPayment(app);
    app.sessions.end();
    signIn(app, OWNER);

    await expect(start(app, cart)).resolves.toBe(attempt);
    await payCash(app, attempt, 10_000);
    expect(lineStates(attempt)).toEqual(['applied', 'applied']);
  });

  it('another session cannot resume it: the slot stays refused', async () => {
    const app = boot();
    const { cart } = await midPayment(app);
    app.sessions.end();
    signIn(app, OTHER);
    const r = await app.start({ ...envelope(cart), idempotency_key: 'k-other' });
    expect(r).toEqual({ kind: 'refused', reason: 'attempt_already_started_on_terminal' });
  });
});

describe('RT-442 — zero funds (Z2)', () => {
  it('a started attempt with no tender is cancelled at session end and frees the slot', async () => {
    const app = boot();
    const owner = signIn(app, OWNER);
    const attempt = await start(app, frozenCart(owner, 'cart-1'));

    app.sessions.end();

    expect(attemptRow(attempt).state).toBe('cancelled');
    const cancelled = app.paymentAudit.find((e) => e.action_category === 'payment.cancelled');
    expect(cancelled?.payload).toMatchObject({
      payment_attempt_id: attempt,
      cause: 'session_ended_no_funds',
    });
    const other = signIn(app, OTHER);
    await expect(start(app, frozenCart(other, 'cart-2'))).resolves.toEqual(expect.any(String));
  });

  it('after a restart, the next sign-in closes it (any operator)', async () => {
    const first = boot();
    const owner = signIn(first, OWNER);
    const attempt = await start(first, frozenCart(owner, 'cart-1'));

    const app = boot();
    expect(attemptRow(attempt).state).toBe('started');
    signIn(app, OTHER);
    expect(attemptRow(attempt).state).toBe('cancelled');
  });

  it('the owner’s frozen cart re-attaches and starts a new attempt from its envelope', async () => {
    const app = boot();
    const owner = signIn(app, OWNER);
    const cart = frozenCart(owner, 'cart-1');
    const first = await start(app, cart);
    app.sessions.end();

    const back = signIn(app, OWNER);
    expect(app.held.getResumeState(back)).toEqual({
      cart_id: cart,
      payment_attempt_id: null,
      other_held_cart_count: 0,
    });
    const second = await start(app, cart);
    expect(second).not.toBe(first);
    expect(attemptRow(second)).toEqual({ state: 'started', operator_session_id: back.id });
  });
});

describe('RT-442 — a frozen cart with no attempt', () => {
  it('is held at session end and starts a new attempt after re-attach', async () => {
    const app = boot();
    const owner = signIn(app, OWNER);
    const cart = frozenCart(owner, 'cart-1');
    app.sessions.end();
    expect(categories(app.paymentAudit)).toEqual([]);

    const back = signIn(app, OWNER);
    expect(cartSession(cart)).toBe(back.id);
    await expect(start(app, cart)).resolves.toEqual(expect.any(String));
  });
});

describe('RT-442 — a settled sale is untouched', () => {
  it('is never held or re-attached', async () => {
    const app = boot();
    const owner = signIn(app, OWNER);
    const cart = frozenCart(owner, 'cart-1');
    const attempt = await start(app, cart);
    await payCash(app, attempt, 15_000);
    app.paymentAttemptFsm.confirm({
      payment_attempt_id: attempt,
      settled_at: NOW,
      action_id: 'k-settle',
    });
    expect(attemptRow(attempt).state).toBe('settled');

    app.sessions.end();
    const back = signIn(app, OWNER);
    expect(cartSession(cart)).toBe(owner.id);
    expect(app.held.getResumeState(back).cart_id).toBeNull();
    expect(categories(app.cartAudit)).not.toContain('cart.held_on_session_end');
  });
});
