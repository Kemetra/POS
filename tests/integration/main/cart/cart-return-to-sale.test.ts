/**
 * RT-26 — Safe Checkout Back / Esc to the active sale (`cart.returnToSale`).
 *
 * Exercised end to end in the main process against the REAL migration chain
 * (0001…0037, sql.js) through the PRODUCTION factories: `createCartBridgeHandlers`
 * with `bindCheckoutReturnGuard`, and the real payments.start / tender.apply /
 * payments.confirm handlers over the real payment FSMs. Nothing is mocked
 * except the audit sinks (captured) and the catalogue resolver (fixture).
 *
 * Covers the RT-26 acceptance criteria:
 *   - success: the SAME cart returns to `editing` with lines/qty/notes/versions
 *     intact, no second cart, no void/cancel, envelope invalidated atomically;
 *   - a zero-funds started attempt is cancelled with the Back (no second open
 *     attempt), and the old envelope / attempt can no longer pay;
 *   - re-entering Checkout hands off a NEW envelope on the current cart version;
 *   - refusal once any tender exists, or the payment settled / was force-failed;
 *   - Back vs Confirm races resolve to exactly one winner, deterministically;
 *   - replayed / stale Back requests are idempotent or refused;
 *   - fail-closed wiring and atomic rollback.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Logger } from 'pino';

import { createCartBridgeHandlers } from '../../../../src/main/cart/wire-cart-handlers.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { DatabaseHandle } from '../../../../src/main/db/client.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import {
  bindCheckoutReturnAllowed,
  bindCheckoutReturnGuard,
} from '../../../../src/main/payments/checkout-return-guard.js';
import {
  bindAttemptHasLiveTender,
  bindCartPaymentStatus,
  bindPaymentAttemptsRepository,
} from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../../src/main/payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from '../../../../src/main/payments/idempotency.js';
import {
  createPaymentAuditEmitter,
  type PaymentAuditEvent,
} from '../../../../src/main/payments/audit-emitter.js';
import { bindCartPaymentEligibility } from '../../../../src/main/payments/cart-payment-eligibility.js';
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { createPaymentsCancelHandler } from '../../../../src/main/payments/handlers/payments-cancel.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import type { OperatorSessionForPayments } from '../../../../src/main/payments/require-operator-session.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';
import { makeSqlJsHandle } from '../../../unit/main/cart/__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname0, '..', '..', '..', '..', 'migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const TERMINAL = 'terminal-1';

interface OperatorSpec {
  readonly id: string;
  readonly role?: OperatorSessionRecord['role'];
}

function operator({ id, role = 'cashier' }: OperatorSpec): OperatorSessionRecord {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: 'Cashier',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-04T08:00:00.000Z',
    backend_session_id: `b-${id}`,
    last_activity_at: '2026-10-04T08:00:00.000Z',
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const CATALOGUE: Record<string, { display_name: string; unit_price_minor: number }> = {
  'item-a': { display_name: 'Panadol', unit_price_minor: 1500 },
  'item-b': { display_name: 'Vitamin C', unit_price_minor: 2500 },
  'item-free': { display_name: 'Sample', unit_price_minor: 0 },
};

const resolver: ItemRefResolver = (ref) => {
  const hit = CATALOGUE[ref];
  return Promise.resolve(
    hit === undefined ? { kind: 'refused', reason: 'unknown_item' } : { kind: 'ok', ...hit },
  );
};

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  for (const sql of MIGRATIONS) db.exec(sql);
});
afterEach(() => {
  db.close();
});

let keySeq = 0;
function key(label: string): string {
  keySeq += 1;
  return `${label}-${String(keySeq)}`;
}

interface SqlQuery {
  readonly sql: string;
  readonly params?: (string | number)[];
}

function rows({ sql, params = [] }: SqlQuery): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out: Record<string, unknown>[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function one(query: SqlQuery): Record<string, unknown> | undefined {
  return rows(query)[0];
}

/** Narrows a bridge response to its `ok` branch, failing the fixture otherwise. */
function assertOk<T extends { kind: string }>(
  res: T,
  label: string,
): asserts res is Extract<T, { kind: 'ok' }> {
  if (res.kind !== 'ok') throw new Error(`${label} failed`);
}

interface PaymentCore {
  attempts: ReturnType<typeof bindPaymentAttemptsRepository>;
  lines: ReturnType<typeof bindPaymentTenderLinesRepository>;
  paymentAttemptFsm: ReturnType<typeof createPaymentAttemptFsm>;
  tenderLineFsm: ReturnType<typeof createTenderLineFsm>;
  paymentAuditEmitter: ReturnType<typeof createPaymentAuditEmitter>;
  idempotency: ReturnType<typeof createIdempotencyHelper>;
}

/** Repositories, FSMs and the payment audit emitter, as main wires them. */
function buildPaymentCore(handle: DatabaseHandle, paymentAudit: PaymentAuditEvent[]): PaymentCore {
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  return {
    attempts,
    lines,
    paymentAttemptFsm: createPaymentAttemptFsm({ db: handle, attempts, lines, outbox }),
    tenderLineFsm: createTenderLineFsm({ db: handle, attempts, lines, outbox }),
    paymentAuditEmitter: createPaymentAuditEmitter({
      sink: { write: (evt) => paymentAudit.push(evt) },
    }),
    idempotency: createIdempotencyHelper({ outbox }),
  };
}

/** The payments session main derives from the operator session + paired terminal. */
function paymentsSessionOf(
  current: OperatorSessionRecord | null,
): OperatorSessionForPayments | null {
  if (current === null) return null;
  return {
    role: current.role,
    operator_id: current.operator_id,
    operator_session_id: current.id,
    tenant_id: current.tenant_id,
    branch_id: current.branch_id,
    terminal_id: TERMINAL,
    display_name: current.display_name,
  };
}

function sequentialUuid(): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return `uuid-${String(seq)}`;
  };
}

/** The real payments.start / confirm / cancel and tender.apply handlers. */
function buildPaymentHandlers(
  handle: DatabaseHandle,
  core: PaymentCore,
  getSession: () => OperatorSessionRecord | null,
) {
  const writeDeps = {
    getCurrentSession: () => paymentsSessionOf(getSession()),
    attemptsRepo: core.attempts,
    linesRepo: core.lines,
    idempotency: core.idempotency,
    auditEmitter: core.paymentAuditEmitter,
    clock: () => new Date('2026-10-04T10:00:00.000Z'),
  };
  const { paymentAttemptFsm, tenderLineFsm } = core;
  const uuid = sequentialUuid();
  return {
    start: createPaymentsStartHandler({
      ...writeDeps,
      paymentAttemptFsm,
      uuid,
      checkCartForPayment: bindCartPaymentEligibility(handle),
      attemptHasLiveTender: bindAttemptHasLiveTender(handle),
    }),
    confirm: createPaymentsConfirmHandler({ ...writeDeps, paymentAttemptFsm }),
    cancel: createPaymentsCancelHandler({ ...writeDeps, paymentAttemptFsm }),
    apply: createTenderApplyHandler({ ...writeDeps, tenderLineFsm, uuid }),
  };
}

interface CapturedCartAudit {
  action_category: string;
  payload: Record<string, unknown>;
}

/** Production-shaped stack over one database. */
function buildStack(session: OperatorSessionRecord = operator({ id: 'sess-1' })) {
  let current: OperatorSessionRecord | null = session;
  const handle = makeSqlJsHandle(db);
  const cartAudit: CapturedCartAudit[] = [];
  const paymentAudit: PaymentAuditEvent[] = [];
  const core = buildPaymentCore(handle, paymentAudit);

  const cart = createCartBridgeHandlers({
    dbHandle: handle,
    getCurrentSession: () => current,
    getTerminalId: () => TERMINAL,
    logger,
    auditEmitter: {
      emit: (evt: CapturedCartAudit) => cartAudit.push(evt),
    } as unknown as AuditEmitter,
    isPackaged: true,
    productionResolver: resolver,
    cartPaymentStatus: bindCartPaymentStatus(handle),
    checkoutReturnAllowed: bindCheckoutReturnAllowed(handle),
    releaseCheckoutPayment: bindCheckoutReturnGuard({
      db: handle,
      paymentAttemptFsm: core.paymentAttemptFsm,
      auditEmitter: core.paymentAuditEmitter,
    }),
  });

  return {
    handle,
    cart,
    payments: buildPaymentHandlers(handle, core, () => current),
    paymentAttemptFsm: core.paymentAttemptFsm,
    tenderLineFsm: core.tenderLineFsm,
    cartAudit,
    paymentAudit,
    setSession: (s: OperatorSessionRecord | null) => {
      current = s;
    },
  };
}

type Stack = ReturnType<typeof buildStack>;

function firstLine(cartId: string): { line_id: string; version: number } {
  const row = one({
    sql: `SELECT line_id, version FROM cart_lines WHERE cart_id = ? ORDER BY created_at`,
    params: [cartId],
  });
  if (row === undefined) throw new Error('no lines');
  return { line_id: row['line_id'] as string, version: row['version'] as number };
}

/** Sale: create a cart, add the items, then qty +1 and a note on the first line. */
async function ringSale(s: Stack, items: string[] = ['item-a', 'item-b']): Promise<string> {
  const created = await s.cart.create({ idempotency_key: key('create') });
  assertOk(created, 'create');
  const cart_id = created.cart_id;
  for (const item_ref of items) {
    assertOk(
      await s.cart.linesAdd({ cart_id, item_ref, quantity: 1, idempotency_key: key('add') }),
      `add ${item_ref}`,
    );
  }
  const { line_id, version } = firstLine(cart_id);
  const inc = await s.cart.linesUpdate({
    cart_id,
    line_id,
    op: 'increment',
    version,
    idempotency_key: key('inc'),
  });
  assertOk(inc, 'increment');
  const note = 'after meals';
  assertOk(
    await s.cart.linesSetNote({
      cart_id,
      line_id,
      note,
      version: inc.version,
      idempotency_key: key('note'),
    }),
    'note',
  );
  return cart_id;
}

async function handoff(s: Stack, cartId: string): Promise<PaymentIntentEnvelope> {
  const snap = await s.cart.snapshot({ cart_id: cartId });
  if (snap.kind !== 'ok') throw new Error('snapshot failed');
  const res = await s.cart.handoff({
    cart_id: cartId,
    per_line_versions: snap.snapshot.lines.map((l) => ({ line_id: l.line_id, version: l.version })),
    idempotency_key: key('handoff'),
  });
  if (res.kind !== 'ok') throw new Error(`handoff failed: ${res.reason}`);
  return res.envelope;
}

async function startPayment(s: Stack, env: PaymentIntentEnvelope): Promise<string> {
  const res = await s.payments.start({
    envelope_handoff_action_id: env.handoff_action_id,
    envelope_cart_id: env.cart_id,
    envelope_subtotal_minor: env.subtotal_minor,
    envelope_version: 'v1',
    idempotency_key: key('start'),
  });
  if (res.kind !== 'ok') throw new Error(`start failed: ${res.reason}`);
  return res.payment_attempt_id;
}

function back(s: Stack, env: PaymentIntentEnvelope, opts: { key?: string } = {}) {
  const idempotency_key = opts.key ?? key('back');
  return s.cart.returnToSale({
    cart_id: env.cart_id,
    handoff_action_id: env.handoff_action_id,
    idempotency_key,
  });
}

function cartRow(cartId: string) {
  return one({ sql: `SELECT * FROM carts WHERE cart_id = ?`, params: [cartId] });
}

function lineProjection(cartId: string) {
  return rows({
    sql: `SELECT line_id, item_ref, display_name, quantity, unit_price_minor, line_subtotal_minor,
            note, version, removed_at
       FROM cart_lines WHERE cart_id = ? ORDER BY created_at`,
    params: [cartId],
  });
}

function attemptState(attemptId: string): unknown {
  return one({
    sql: `SELECT state FROM payment_attempts WHERE payment_attempt_id = ?`,
    params: [attemptId],
  })?.['state'];
}

function outboxKinds(cartId: string): unknown[] {
  return rows({
    sql: `SELECT action_kind FROM cart_action_outbox WHERE cart_id = ?`,
    params: [cartId],
  }).map((r) => r['action_kind']);
}

/** Same cart row, now editing, envelope cleared, nothing cancelled, lines untouched. */
function expectReturnedDraft({
  cartId,
  linesBefore,
}: {
  cartId: string;
  linesBefore: Record<string, unknown>[];
}): void {
  expect(cartRow(cartId)).toMatchObject({
    state: 'editing',
    frozen_at: null,
    // The envelope is invalidated in the same transaction.
    handoff_envelope_json: null,
    cancelled_at: null,
  });
  expect(lineProjection(cartId)).toEqual(linesBefore);
  // No second cart.
  expect(one({ sql: `SELECT COUNT(*) AS n FROM carts` })?.['n']).toBe(1);
}

/** The Back is recorded (outbox + audit); no void / cancel is. */
function expectOnlyReturnRecorded(s: Stack, env: PaymentIntentEnvelope): void {
  const kinds = outboxKinds(env.cart_id);
  expect(kinds).toContain('cart.return_to_sale');
  expect(kinds).not.toContain('cart.void');
  expect(kinds).not.toContain('cart.cancel.post_handoff');
  expect(s.cartAudit.map((e) => e.action_category)).toEqual([
    'cart.handoff_to_payment',
    'cart.return_to_sale',
  ]);
  expect(s.cartAudit[1]?.payload).toEqual({
    cart_id: env.cart_id,
    handoff_action_id: env.handoff_action_id,
    cancelled_payment_attempt_id: null,
  });
}

/** The snapshot the Sale screen hydrates from is editable, unpaid, with no envelope. */
async function expectEditableSnapshot(s: Stack, { cartId }: { cartId: string }): Promise<void> {
  const snap = await s.cart.snapshot({ cart_id: cartId });
  assertOk(snap, 'snapshot');
  expect(snap.snapshot).toMatchObject({ state: 'editing', envelope: null, paid: false });
}

describe('RT-26 cart.returnToSale — success', () => {
  it('returns the SAME cart to editing with lines, qty, notes and versions intact', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const linesBefore = lineProjection(cartId);
    const env = await handoff(s, cartId);
    expect(cartRow(cartId)?.['state']).toBe('frozen_handed_off');

    expect(await back(s, env)).toEqual({ kind: 'ok' });

    expectReturnedDraft({ cartId: cartId, linesBefore: linesBefore });
    expectOnlyReturnRecorded(s, env);
    await expectEditableSnapshot(s, { cartId: cartId });
  });

  it('cancels a zero-funds started attempt with the Back, leaving no open attempt', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    const attemptId = await startPayment(s, env);

    expect(await back(s, env, { key: 'back-zero-funds' })).toEqual({ kind: 'ok' });

    expect(attemptState(attemptId)).toBe('cancelled');
    expect(
      one({ sql: `SELECT COUNT(*) AS n FROM payment_attempts WHERE state = 'started'` })?.['n'],
    ).toBe(0);
    expect(
      one({
        sql: `SELECT action_kind FROM payment_action_outbox WHERE action_id = ?`,
        params: ['back-zero-funds:payment-cancel'],
      })?.['action_kind'],
    ).toBe('payment.cancel');
    expect(s.paymentAudit.map((e) => e.action_category)).toEqual(['payment.cancelled']);
    expect(s.cartAudit.at(-1)?.payload['cancelled_payment_attempt_id']).toBe(attemptId);
    expect(cartRow(cartId)?.['state']).toBe('editing');
  });

  it('makes the old envelope and attempt unusable for payment', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    const attemptId = await startPayment(s, env);
    expect(await back(s, env)).toEqual({ kind: 'ok' });

    // payments.start with the old envelope: the cart is no longer handed off.
    const restart = await s.payments.start({
      envelope_handoff_action_id: env.handoff_action_id,
      envelope_cart_id: env.cart_id,
      envelope_subtotal_minor: env.subtotal_minor,
      envelope_version: 'v1',
      idempotency_key: key('start-old'),
    });
    expect(restart).toEqual({ kind: 'refused', reason: 'cart_lost' });
    // The old attempt can take no tender and never settle.
    expect(
      await s.payments.apply({
        payment_attempt_id: attemptId,
        tender_type: 'cash',
        amount_applied_minor: env.subtotal_minor,
        idempotency_key: key('apply-old'),
      }),
    ).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
    expect(
      await s.payments.confirm({ payment_attempt_id: attemptId, idempotency_key: key('confirm') }),
    ).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
  });

  it('re-entering Checkout hands off a fresh envelope on the edited cart; the old one stays stale', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const first = await handoff(s, cartId);
    await startPayment(s, first);
    expect(await back(s, first)).toEqual({ kind: 'ok' });

    // Edit the same draft: add one more line.
    const added = await s.cart.linesAdd({
      cart_id: cartId,
      item_ref: 'item-a',
      quantity: 1,
      idempotency_key: key('add-more'),
    });
    expect(added.kind).toBe('ok');

    const second = await handoff(s, cartId);
    expect(second.cart_id).toBe(cartId);
    expect(second.handoff_action_id).not.toBe(first.handoff_action_id);
    expect(second.subtotal_minor).toBe(first.subtotal_minor + 1500);

    // The new envelope pays; the old one is refused even though the cart is frozen again.
    const stale = await s.payments.start({
      envelope_handoff_action_id: first.handoff_action_id,
      envelope_cart_id: cartId,
      envelope_subtotal_minor: first.subtotal_minor,
      envelope_version: 'v1',
      idempotency_key: key('start-stale'),
    });
    expect(stale).toEqual({ kind: 'refused', reason: 'stale_handoff' });
    const attemptId = await startPayment(s, second);
    expect(
      await s.payments.apply({
        payment_attempt_id: attemptId,
        tender_type: 'cash',
        amount_applied_minor: second.subtotal_minor,
        idempotency_key: key('apply'),
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(
      await s.payments.confirm({ payment_attempt_id: attemptId, idempotency_key: key('confirm') }),
    ).toMatchObject({ kind: 'ok' });
    // Back after the new handoff is not reachable with the old envelope either.
    expect(await back(s, first)).toEqual({ kind: 'refused', reason: 'stale_version' });
  });

  it('can be repeated: Back, edit, Checkout, Back again', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const first = await handoff(s, cartId);
    expect(await back(s, first)).toEqual({ kind: 'ok' });
    const second = await handoff(s, cartId);
    expect(await back(s, second)).toEqual({ kind: 'ok' });
    expect(cartRow(cartId)?.['state']).toBe('editing');
  });
});

describe('RT-26 cart.returnToSale — refused once money or a payment outcome exists', () => {
  async function frozenWithAttempt(s: Stack) {
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    const attemptId = await startPayment(s, env);
    return { cartId, env, attemptId };
  }

  function expectUntouched(
    s: Stack,
    f: { cartId: string; env: PaymentIntentEnvelope; auditCount: number },
  ) {
    const cart = cartRow(f.cartId);
    expect(cart?.['state']).toBe('frozen_handed_off');
    expect(cart?.['handoff_envelope_json']).not.toBeNull();
    expect(
      rows({ sql: `SELECT 1 FROM cart_action_outbox WHERE action_kind = 'cart.return_to_sale'` }),
    ).toHaveLength(0);
    expect(s.cartAudit.map((e) => e.action_category)).not.toContain('cart.return_to_sale');
    expect(s.cartAudit).toHaveLength(f.auditCount);
  }

  it('refuses with cash applied, writing nothing; the attempt stays open for the payment flow', async () => {
    const s = buildStack();
    const f = await frozenWithAttempt(s);
    await s.payments.apply({
      payment_attempt_id: f.attemptId,
      tender_type: 'cash',
      amount_applied_minor: 1000,
      idempotency_key: key('apply'),
    });
    const audits = s.cartAudit.length;
    const paymentAudits = s.paymentAudit.length;

    expect(await back(s, f.env)).toEqual({ kind: 'refused', reason: 'frozen' });

    expectUntouched(s, { ...f, auditCount: audits });
    expect(attemptState(f.attemptId)).toBe('started');
    expect(s.paymentAudit).toHaveLength(paymentAudits);
  });

  it('refuses when the payment settled', async () => {
    const s = buildStack();
    const f = await frozenWithAttempt(s);
    await s.payments.apply({
      payment_attempt_id: f.attemptId,
      tender_type: 'cash',
      amount_applied_minor: f.env.subtotal_minor,
      idempotency_key: key('apply'),
    });
    await s.payments.confirm({ payment_attempt_id: f.attemptId, idempotency_key: key('confirm') });
    expect(attemptState(f.attemptId)).toBe('settled');
    const audits = s.cartAudit.length;

    expect(await back(s, f.env)).toEqual({ kind: 'refused', reason: 'frozen' });
    expectUntouched(s, { ...f, auditCount: audits });
  });

  it('refuses when an attempt was force-failed (UNKNOWN: tender may have been taken)', async () => {
    const s = buildStack();
    const f = await frozenWithAttempt(s);
    s.paymentAttemptFsm.forceFail({
      payment_attempt_id: f.attemptId,
      force_failed_at: '2026-10-04T10:05:00.000Z',
      manager_operator_id: 'op-manager',
      action_id: key('force-fail'),
    });
    const audits = s.cartAudit.length;
    expect(await back(s, f.env)).toEqual({ kind: 'refused', reason: 'frozen' });
    expectUntouched(s, { ...f, auditCount: audits });
  });

  it('refuses after a tender was applied and reversed (external activity happened)', async () => {
    const s = buildStack();
    const f = await frozenWithAttempt(s);
    const applied = await s.payments.apply({
      payment_attempt_id: f.attemptId,
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1000,
      external_reference: 'A1B2C3',
      idempotency_key: key('apply'),
    });
    if (applied.kind !== 'ok') throw new Error('apply failed');
    const reversed = s.tenderLineFsm.reverse({
      tender_line_id: applied.tender_line_id,
      payment_attempt_id: f.attemptId,
      reversed_at: '2026-10-04T10:06:00.000Z',
      attribution_operator_id: 'op-sess-1',
      action_id: key('reverse'),
    });
    expect(reversed.kind).toBe('ok');
    const audits = s.cartAudit.length;
    expect(await back(s, f.env)).toEqual({ kind: 'refused', reason: 'frozen' });
    expectUntouched(s, { ...f, auditCount: audits });
  });

  it('refuses after a refused card line (the card terminal was used)', async () => {
    const s = buildStack();
    const f = await frozenWithAttempt(s);
    const over = await s.payments.apply({
      payment_attempt_id: f.attemptId,
      tender_type: 'external_card_terminal',
      amount_applied_minor: f.env.subtotal_minor + 1,
      external_reference: 'A1B2C3',
      idempotency_key: key('apply-over'),
    });
    expect(over).toEqual({ kind: 'refused', reason: 'non_cash_overpayment_refused' });
    const audits = s.cartAudit.length;
    expect(await back(s, f.env)).toEqual({ kind: 'refused', reason: 'frozen' });
    expectUntouched(s, { ...f, auditCount: audits });
  });

  it('still refuses after the payment flow cancelled an attempt that had taken tender', async () => {
    const s = buildStack();
    const f = await frozenWithAttempt(s);
    await s.payments.apply({
      payment_attempt_id: f.attemptId,
      tender_type: 'cash',
      amount_applied_minor: 500,
      idempotency_key: key('apply'),
    });
    const cancelled = await s.payments.cancel({
      payment_attempt_id: f.attemptId,
      idempotency_key: key('cancel'),
    });
    expect(cancelled.kind).toBe('ok');
    const audits = s.cartAudit.length;
    expect(await back(s, f.env)).toEqual({ kind: 'refused', reason: 'frozen' });
    expectUntouched(s, { ...f, auditCount: audits });
  });

  it('allows Back when only tender-free attempts were cancelled earlier (history)', async () => {
    const s = buildStack();
    const f = await frozenWithAttempt(s);
    expect(
      (await s.payments.cancel({ payment_attempt_id: f.attemptId, idempotency_key: key('c') }))
        .kind,
    ).toBe('ok');
    expect(await back(s, f.env)).toEqual({ kind: 'ok' });
    expect(cartRow(f.cartId)?.['state']).toBe('editing');
  });
});

describe('RT-26 cart.returnToSale — Back vs Confirm race', () => {
  // A zero-subtotal sale settles with no tender, so BOTH operations are
  // individually legal on the same started attempt: the race is real.
  async function raceFixture() {
    const s = buildStack();
    const cartId = await ringSale(s, ['item-free']);
    const env = await handoff(s, cartId);
    expect(env.subtotal_minor).toBe(0);
    const attemptId = await startPayment(s, env);
    return { s, cartId, env, attemptId };
  }

  it('Back first: Back wins, Confirm is refused, the cart is editable and unpaid', async () => {
    const { s, cartId, env, attemptId } = await raceFixture();
    const [backRes, confirmRes] = await Promise.all([
      back(s, env),
      s.payments.confirm({ payment_attempt_id: attemptId, idempotency_key: key('confirm') }),
    ]);
    expect(backRes).toEqual({ kind: 'ok' });
    expect(confirmRes).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
    expect(attemptState(attemptId)).toBe('cancelled');
    expect(cartRow(cartId)?.['state']).toBe('editing');
  });

  it('Confirm first: Confirm wins, Back is refused, the sale stays paid and frozen', async () => {
    const { s, cartId, env, attemptId } = await raceFixture();
    const [confirmRes, backRes] = await Promise.all([
      s.payments.confirm({ payment_attempt_id: attemptId, idempotency_key: key('confirm') }),
      back(s, env),
    ]);
    expect(confirmRes).toMatchObject({ kind: 'ok' });
    expect(backRes).toEqual({ kind: 'refused', reason: 'frozen' });
    expect(attemptState(attemptId)).toBe('settled');
    expect(cartRow(cartId)?.['state']).toBe('frozen_handed_off');
    expect(cartRow(cartId)?.['handoff_envelope_json']).not.toBeNull();
  });

  it('with tender applied, Back is refused in either order and Confirm settles', async () => {
    for (const backFirst of [true, false]) {
      const s = buildStack();
      const cartId = await ringSale(s);
      const env = await handoff(s, cartId);
      const attemptId = await startPayment(s, env);
      await s.payments.apply({
        payment_attempt_id: attemptId,
        tender_type: 'cash',
        amount_applied_minor: env.subtotal_minor,
        idempotency_key: key('apply'),
      });
      const confirm = (): ReturnType<typeof s.payments.confirm> =>
        s.payments.confirm({ payment_attempt_id: attemptId, idempotency_key: key('confirm') });
      const [a, b] = backFirst
        ? await Promise.all([back(s, env), confirm()])
        : await Promise.all([confirm(), back(s, env)]);
      const [backRes, confirmRes] = backFirst ? [a, b] : [b, a];
      expect(backRes).toEqual({ kind: 'refused', reason: 'frozen' });
      expect(confirmRes).toMatchObject({ kind: 'ok' });
      expect(cartRow(cartId)?.['state']).toBe('frozen_handed_off');
      db.close();
      db = new SQL.Database();
      for (const sql of MIGRATIONS) db.exec(sql);
    }
  });
});

/** The cashier's cart handlers over the same DB, with an injected clock. */
function withCashierClock(s: Stack, clock: () => Date): Stack {
  const cart = new CartBridgeHandlers({
    getCurrentSession: () => operator({ id: 'sess-1' }),
    getTerminalId: () => TERMINAL,
    cartStore: bindCartStore(s.handle),
    clock,
    cartPaymentStatus: bindCartPaymentStatus(s.handle),
    checkoutReturnAllowed: bindCheckoutReturnAllowed(s.handle),
    releaseCheckoutPayment: bindCheckoutReturnGuard({
      db: s.handle,
      paymentAttemptFsm: s.paymentAttemptFsm,
      auditEmitter: createPaymentAuditEmitter({ sink: { write: () => undefined } }),
    }),
  });
  return { ...s, cart };
}

/** A manager's post-handoff cancel of `cartId`, naming `handoffActionId`. */
function managerCancel(
  s: Stack,
  { cartId, handoffActionId }: { cartId: string; handoffActionId: string },
) {
  const manager = new CartBridgeHandlers({
    getCurrentSession: () => operator({ id: 'sess-mgr', role: 'manager' }),
    getTerminalId: () => TERMINAL,
    cartStore: bindCartStore(s.handle),
    cartPaymentStatus: bindCartPaymentStatus(s.handle),
  });
  return manager.cancelPostHandoff({
    cart_id: cartId,
    handoff_action_id: handoffActionId,
    idempotency_key: key('cph'),
  });
}

describe('RT-26 cart.returnToSale — replay, stale and gates', () => {
  it('replays the same Back idempotently (lost response retried with the same key)', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    expect(await back(s, env, { key: 'back-once' })).toEqual({ kind: 'ok' });
    expect(await back(s, env, { key: 'back-once' })).toEqual({ kind: 'ok' });
    expect(
      rows({ sql: `SELECT 1 FROM cart_action_outbox WHERE action_kind = 'cart.return_to_sale'` }),
    ).toHaveLength(1);
    expect(s.cartAudit.filter((e) => e.action_category === 'cart.return_to_sale')).toHaveLength(1);
  });

  it('refuses a stale Back with a new key after the cart already returned', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    expect(await back(s, env)).toEqual({ kind: 'ok' });
    expect(await back(s, env)).toEqual({ kind: 'refused', reason: 'stale_version' });
  });

  it('refuses a key reused for another action or another handoff', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    // The handoff's own action id as the Back key.
    expect(await back(s, env, { key: env.handoff_action_id })).toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
    expect(await back(s, env, { key: 'back-k' })).toEqual({ kind: 'ok' });
    const again = await handoff(s, cartId);
    expect(await back(s, again, { key: 'back-k' })).toEqual({
      kind: 'refused',
      reason: 'idempotency_payload_mismatch',
    });
    expect(cartRow(cartId)?.['state']).toBe('frozen_handed_off');
  });

  it('refuses a handoff id that is not the cart’s latest', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    const res = await s.cart.returnToSale({
      cart_id: cartId,
      handoff_action_id: 'not-the-handoff',
      idempotency_key: key('back'),
    });
    expect(res).toEqual({ kind: 'refused', reason: 'stale_version' });
    expect(cartRow(cartId)?.['state']).toBe('frozen_handed_off');
    expect(env.cart_id).toBe(cartId);
  });

  it('binds to the persisted envelope even when two handoffs share a timestamp', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    // Same clock for every write: both handoffs get an identical applied_at.
    const t = withCashierClock(s, () => new Date('2026-10-04T10:00:00.000Z'));
    const first = await handoff(t, cartId);
    expect(await back(t, first)).toEqual({ kind: 'ok' });
    const second = await handoff(t, cartId);

    expect(await back(t, first)).toEqual({ kind: 'refused', reason: 'stale_version' });
    expect(
      await managerCancel(s, { cartId: cartId, handoffActionId: first.handoff_action_id }),
    ).toEqual({
      kind: 'refused',
      reason: 'stale_version',
    });
    expect(await back(t, second)).toEqual({ kind: 'ok' });
  });

  it('post-handoff cancel follows the persisted envelope even when the clock stepped back', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    // handoff-1 at 10:00, Back, then NTP steps the clock back: handoff-2 lands at 09:00.
    const times = [
      '2026-10-04T10:00:00.000Z',
      '2026-10-04T10:00:01.000Z',
      '2026-10-04T09:00:00.000Z',
    ];
    const t = withCashierClock(s, () => new Date(times.shift() ?? '2026-10-04T09:00:01.000Z'));
    const first = await handoff(t, cartId);
    expect(await back(t, first)).toEqual({ kind: 'ok' });
    const second = await handoff(t, cartId);
    expect(
      one({
        sql: `SELECT applied_at FROM cart_action_outbox WHERE action_id = ?`,
        params: [second.handoff_action_id],
      })?.['applied_at'],
    ).toBe('2026-10-04T09:00:00.000Z');

    // The superseded handoff is stale; the current one (earlier wall clock) cancels.
    expect(
      await managerCancel(s, { cartId: cartId, handoffActionId: first.handoff_action_id }),
    ).toEqual({
      kind: 'refused',
      reason: 'stale_version',
    });
    expect(
      await managerCancel(s, { cartId: cartId, handoffActionId: second.handoff_action_id }),
    ).toEqual({ kind: 'ok' });
    expect(cartRow(cartId)?.['state']).toBe('cancelled');
  });

  it('refuses a cart that was never handed off, and a cancelled cart', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const req = { cart_id: cartId, handoff_action_id: 'h', idempotency_key: key('back') };
    expect(await s.cart.returnToSale(req)).toEqual({ kind: 'refused', reason: 'stale_version' });
    expect((await s.cart.void({ cart_id: cartId, idempotency_key: key('void') })).kind).toBe('ok');
    expect(await s.cart.returnToSale({ ...req, idempotency_key: key('back') })).toEqual({
      kind: 'refused',
      reason: 'closed',
    });
  });

  it('refuses without a session and for another cashier’s cart', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    s.setSession(null);
    expect(await back(s, env)).toEqual({ kind: 'refused', reason: 'no_session' });
    s.setSession(operator({ id: 'sess-other' }));
    expect((await back(s, env)).kind).toBe('refused');
    expect(cartRow(cartId)?.['state']).toBe('frozen_handed_off');
  });

  it('fails closed (not_implemented) when the payments guard is not wired', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    const unguarded = new CartBridgeHandlers({
      getCurrentSession: () => operator({ id: 'sess-1' }),
      getTerminalId: () => TERMINAL,
      cartStore: bindCartStore(s.handle),
    });
    expect(await back({ ...s, cart: unguarded }, env)).toEqual({
      kind: 'refused',
      reason: 'not_implemented',
    });
    expect(cartRow(cartId)?.['state']).toBe('frozen_handed_off');
  });

  it('is atomic: a failure after the attempt cancel rolls back the attempt AND the cart', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    const attemptId = await startPayment(s, env);
    const throwing = createCartBridgeHandlers({
      dbHandle: s.handle,
      getCurrentSession: () => operator({ id: 'sess-1' }),
      getTerminalId: () => TERMINAL,
      logger,
      auditEmitter: {
        emit: () => {
          throw new Error('audit store unavailable');
        },
      } as unknown as AuditEmitter,
      isPackaged: true,
      cartPaymentStatus: bindCartPaymentStatus(s.handle),
      checkoutReturnAllowed: bindCheckoutReturnAllowed(s.handle),
      releaseCheckoutPayment: bindCheckoutReturnGuard({
        db: s.handle,
        paymentAttemptFsm: s.paymentAttemptFsm,
        auditEmitter: createPaymentAuditEmitter({ sink: { write: () => undefined } }),
      }),
    });
    await expect(back({ ...s, cart: throwing }, env)).rejects.toThrow('audit store unavailable');
    expect(attemptState(attemptId)).toBe('started');
    const cart = cartRow(cartId);
    expect(cart?.['state']).toBe('frozen_handed_off');
    expect(cart?.['handoff_envelope_json']).not.toBeNull();
    expect(
      rows({ sql: `SELECT 1 FROM payment_action_outbox WHERE action_kind = 'payment.cancel'` }),
    ).toHaveLength(0);
  });

  it('leaves void / post-handoff cancel semantics unchanged after a Back', async () => {
    const s = buildStack();
    const cartId = await ringSale(s);
    const env = await handoff(s, cartId);
    expect(await back(s, env)).toEqual({ kind: 'ok' });
    // Back to a pre-handoff draft: post-handoff cancel no longer applies…
    s.setSession(operator({ id: 'sess-1', role: 'cashier' }));
    expect(
      await s.cart.cancelPostHandoff({
        cart_id: cartId,
        handoff_action_id: env.handoff_action_id,
        idempotency_key: key('cph'),
      }),
    ).toMatchObject({ kind: 'refused' });
    // …and an ordinary void works exactly as for any draft.
    expect(await s.cart.void({ cart_id: cartId, idempotency_key: key('void') })).toEqual({
      kind: 'ok',
    });
    expect(cartRow(cartId)?.['cancellation_reason']).toBe('cashier_voided');
  });
});

describe('RT-26 cart.returnToSaleEligibility — read-only twin of the guard', () => {
  function eligibility(s: Stack, env: PaymentIntentEnvelope) {
    return s.cart.returnToSaleEligibility({
      cart_id: env.cart_id,
      handoff_action_id: env.handoff_action_id,
    });
  }

  /** Every write surface the Back touches, to prove the read touches none. */
  function writeCounts(): unknown[] {
    return [
      'SELECT COUNT(*) AS n FROM cart_action_outbox',
      'SELECT COUNT(*) AS n FROM payment_action_outbox',
      "SELECT COUNT(*) AS n FROM payment_attempts WHERE state = 'started'",
    ].map((sql) => one({ sql: sql })?.['n']);
  }

  it('is returnable for a fresh handoff and for a zero-funds started attempt, writing nothing', async () => {
    const s = buildStack();
    const env = await handoff(s, await ringSale(s));
    expect(await eligibility(s, env)).toEqual({ kind: 'ok', returnable: true });
    const attemptId = await startPayment(s, env);
    const before = writeCounts();
    const audits = [s.cartAudit.length, s.paymentAudit.length];

    expect(await eligibility(s, env)).toEqual({ kind: 'ok', returnable: true });

    expect(writeCounts()).toEqual(before);
    expect([s.cartAudit.length, s.paymentAudit.length]).toEqual(audits);
    expect(attemptState(attemptId)).toBe('started');
    expect(cartRow(env.cart_id)?.['state']).toBe('frozen_handed_off');
  });

  it('stays not returnable after tender was applied and the payment was cancelled (remount case)', async () => {
    const s = buildStack();
    const env = await handoff(s, await ringSale(s));
    const attemptId = await startPayment(s, env);
    await s.payments.apply({
      payment_attempt_id: attemptId,
      tender_type: 'cash',
      amount_applied_minor: 500,
      idempotency_key: key('apply'),
    });
    expect(await eligibility(s, env)).toEqual({ kind: 'ok', returnable: false });
    await s.payments.cancel({ payment_attempt_id: attemptId, idempotency_key: key('cancel') });

    // Durable answer, independent of any renderer state: Back is still refused.
    expect(await eligibility(s, env)).toEqual({ kind: 'ok', returnable: false });
    expect(await back(s, env)).toEqual({ kind: 'refused', reason: 'frozen' });
  });

  it('is not returnable for a stale handoff or a cart that already returned', async () => {
    const s = buildStack();
    const env = await handoff(s, await ringSale(s));
    expect(
      await s.cart.returnToSaleEligibility({ cart_id: env.cart_id, handoff_action_id: 'other' }),
    ).toEqual({ kind: 'ok', returnable: false });
    expect(await back(s, env)).toEqual({ kind: 'ok' });
    expect(await eligibility(s, env)).toEqual({ kind: 'ok', returnable: false });
  });

  it('agrees with the guard once a payment settled', async () => {
    const s = buildStack();
    const cartId = await ringSale(s, ['item-free']);
    const env = await handoff(s, cartId);
    const attemptId = await startPayment(s, env);
    await s.payments.confirm({ payment_attempt_id: attemptId, idempotency_key: key('confirm') });
    expect(await eligibility(s, env)).toEqual({ kind: 'ok', returnable: false });
  });

  it('is gated like every cart read, and fails closed without the read wiring', async () => {
    const s = buildStack();
    const env = await handoff(s, await ringSale(s));
    s.setSession(null);
    expect(await eligibility(s, env)).toEqual({ kind: 'refused', reason: 'no_session' });
    s.setSession(operator({ id: 'sess-other' }));
    expect((await eligibility(s, env)).kind).toBe('refused');
    const unwired = new CartBridgeHandlers({
      getCurrentSession: () => operator({ id: 'sess-1' }),
      getTerminalId: () => TERMINAL,
      cartStore: bindCartStore(s.handle),
    });
    expect(await eligibility({ ...s, cart: unwired }, env)).toEqual({
      kind: 'refused',
      reason: 'not_implemented',
    });
  });
});
