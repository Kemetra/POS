/**
 * RT-496 — payment settlement and its `payment.settled` audit are atomic, and
 * settled attempts stranded without that audit are healed or held.
 *
 * Real stack over sql.js with every migration applied (the RT-481 probe's
 * set-up). "Restart" means rebuilding every object over the same database.
 *
 *   AC1  a throw at the settle/audit boundary leaves both rows or neither.
 *   AC2  a pre-seeded strand WITH durable attribution is healed once, then
 *        dispatched once; cash-up stays held until it is finalized. A legacy
 *        strand WITHOUT attribution is flagged and held: no audit, no Sale.
 *   AC3  finalizing the same handoff twice yields one Sale.
 *   AC4  a same-key confirm retry after a fault settles with its audit.
 *   AC6  the cart stays paid and a new attempt on it is refused.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  attemptActionPayload,
  hashActionPayload,
} from '../../../../src/main/payments/action-payload.js';
import { bindPaymentActionOutboxRepository } from '../../../../src/main/payments/repositories/payment-action-outbox.repository.js';
import { bindPaymentAttemptsRepository } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { bindPaymentTenderLinesRepository } from '../../../../src/main/payments/repositories/payment-tender-lines.repository.js';
import { createPaymentAttemptFsm } from '../../../../src/main/payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from '../../../../src/main/payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from '../../../../src/main/payments/idempotency.js';
import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import {
  createPaymentAuditEmitter,
  type PaymentAuditEvent,
} from '../../../../src/main/payments/audit-emitter.js';
import { bindCartPaymentEligibility } from '../../../../src/main/payments/cart-payment-eligibility.js';
import { bindCartPaymentStatus } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';
import { createSettlementCommitter } from '../../../../src/main/payments/settlement-commit.js';
import { createSettledAuditReconciler } from '../../../../src/main/payments/settled-audit-reconciler.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import { createFinalizeListener } from '../../../../src/main/sales/finalize-listener.js';
import { buildFinalizeInput } from '../../../../src/main/sales/finalize-dispatch.js';
import { bindFinalizeTransaction } from '../../../../src/main/sales/finalize-transaction.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import { createShiftCashupSources } from '../../../../src/main/shift-cashup/shift-cashup-sources.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { makeSession } from './__fixtures__/bridge-handler-deps.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const MIGRATION_DIR = path.join(REPO_ROOT, 'migrations');
const MIGRATIONS = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(path.join(MIGRATION_DIR, f), 'utf8'));

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'terminal-1';
const SCOPE = { tenant_id: TENANT, branch_id: BRANCH, terminal_id: TERMINAL };
const CASHUP_SCOPE = { tenantId: TENANT, branchId: BRANCH, terminalId: TERMINAL };
const SETTLED_AT = '2026-10-08T10:00:00.000Z';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

let db: SqlJsDatabase;
beforeEach(() => {
  db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of MIGRATIONS) db.exec(sql);
  db.run(
    `INSERT INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id)
     VALUES (1, ?, ?, ?, 'TERM-01', 1716800000, 'Maadi', '12 Road 9', 'TRN-1')`,
    [TENANT, BRANCH, TERMINAL],
  );
  seedFrozenCart('cart-1', 'handoff-cart-1', 1500);
});

function seedFrozenCart(cart_id: string, handoff_action_id: string, subtotal: number): void {
  const envelope = {
    envelope_version: 'v1',
    cart_id,
    operator_session_id: 'sess-1',
    owning_operator_id: 'op-clerk-user-abc',
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    lines: [
      {
        line_id: `${cart_id}-line-1`,
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 1,
        unit_price_minor: subtotal,
        line_subtotal_minor: subtotal,
        note: null,
        version: 1,
        last_action_id: 'a1',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: subtotal,
    created_at: '2026-10-08T09:00:00.000Z',
    handoff_action_id,
  };
  db.run(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
       state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
       cancellation_reason, handoff_envelope_json, last_action_id
     ) VALUES (?, ?, ?, ?, 'op-clerk-user-abc', 'sess-1', 'frozen_handed_off', ?,
       '2026-10-08T09:00:00.000Z', '2026-10-08T09:30:00.000Z', '2026-10-08T09:30:00.000Z',
       NULL, NULL, ?, 'a1')`,
    [cart_id, TENANT, BRANCH, TERMINAL, subtotal, JSON.stringify(envelope)],
  );
}

/**
 * A settled attempt with no `payment.settled` audit and no Sale: the state
 * RT-481 reproduced. `displayName` null is a legacy (pre-RT-496) strand.
 */
function seedStrand(opts: {
  id: string;
  cart: string;
  handoff: string;
  displayName: string | null;
}) {
  seedFrozenCart(opts.cart, opts.handoff, 2000);
  db.run(
    `INSERT INTO payment_attempts (
       payment_attempt_id, tenant_id, branch_id, terminal_id, acting_operator_id,
       operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, settled_at, last_action_id,
       selling_operator_display_name
     ) VALUES (?, ?, ?, ?, 'op-clerk-user-abc', 'sess-1', ?, ?, 2000, 'settled',
       '2026-10-07T08:00:00.000Z', '2026-10-07T08:01:00.000Z', ?, ?)`,
    [opts.id, TENANT, BRANCH, TERMINAL, opts.handoff, opts.cart, `k-${opts.id}`, opts.displayName],
  );
  db.run(
    `INSERT INTO payment_tender_lines (
       tender_line_id, payment_attempt_id, tender_type, amount_applied_minor,
       state, applied_at, attribution_operator_id, apply_order, last_action_id
     ) VALUES (?, ?, 'cash', 2000, 'applied', '2026-10-07T08:00:30.000Z',
       'op-clerk-user-abc', 1, ?)`,
    [`tl-${opts.id}`, opts.id, `k-${opts.id}`],
  );
}

interface BootOptions {
  failOnSettledAudit?: boolean;
}

/** One "process": every object rebuilt over the same DB (restart = call again). */
function boot(opts: BootOptions = {}) {
  const handle = makeSqlJsHandle(db);
  const attempts = bindPaymentAttemptsRepository(handle);
  const lines = bindPaymentTenderLinesRepository(handle);
  const outbox = bindPaymentActionOutboxRepository(handle);
  const tenderLineFsm = createTenderLineFsm({ db: handle, attempts, lines, outbox });
  const paymentAttemptFsm = createPaymentAttemptFsm({ db: handle, attempts, lines, outbox });
  const idempotency = createIdempotencyHelper({ outbox });
  const store = bindAuditEventsStoreDb(handle);
  let n = 0;
  // Mirrors index.ts forwardAuditEvent (same handle, insertIgnore).
  const write = (evt: PaymentAuditEvent): void => {
    if (opts.failOnSettledAudit === true && evt.action_category === 'payment.settled') {
      throw new Error('INJECTED: audit insert failed at the settle boundary');
    }
    n += 1;
    store.insertIgnore({
      event_id: `evt-${String(n)}-${evt.action_category}`,
      tenant_id: evt.tenant_id,
      branch_id: evt.branch_id,
      originating_terminal_id: evt.originating_terminal_id,
      acting_operator_id: evt.attribution_operator_id,
      session_id: evt.session_id,
      shift_id: null,
      action_category: evt.action_category as never,
      created_at: evt.created_at,
      approving_supervisor_id: null,
      payload: evt.payload,
    });
  };
  const auditEmitter = createPaymentAuditEmitter({ sink: { write } });
  const settlement = createSettlementCommitter({
    db: handle,
    paymentAttemptFsm,
    attemptsRepo: attempts,
    auditEmitter,
  });
  const reconciler = createSettledAuditReconciler({
    db: handle,
    linesRepo: lines,
    auditEmitter,
    now: () => '2026-10-08T12:00:00.000Z',
  });
  const session = makeSession();
  const shared = {
    getCurrentSession: () => session,
    attemptsRepo: attempts,
    idempotency,
    auditEmitter,
    clock: () => new Date(SETTLED_AT),
  };
  const uuid = (): string => `uuid-${String(++n)}`;
  return {
    handle,
    attempts,
    reconciler,
    start: createPaymentsStartHandler({
      ...shared,
      paymentAttemptFsm,
      uuid,
      checkCartForPayment: bindCartPaymentEligibility(handle),
      attemptHasLiveTender: () => false,
    }),
    apply: createTenderApplyHandler({ ...shared, linesRepo: lines, tenderLineFsm, uuid }),
    confirm: createPaymentsConfirmHandler({
      ...shared,
      linesRepo: lines,
      paymentAttemptFsm,
      settlement,
      settledAuditReconciler: reconciler,
    }),
  };
}

function count(sql: string, ...params: unknown[]): number {
  const st = db.prepare(sql);
  st.bind(params as never);
  st.step();
  const v = st.get()[0] as number;
  st.free();
  return v;
}

const settledAudits = (attempt: string): number =>
  count(
    `SELECT COUNT(*) FROM audit_events WHERE action_category = 'payment.settled'
       AND json_extract(payload, '$.payment_attempt_id') = ?`,
    attempt,
  );

function listenerDispatches(): string[] {
  const p = boot();
  const seen: string[] = [];
  createFinalizeListener({
    db: p.handle,
    ...SCOPE,
    dispatch: (h) => seen.push(h),
    tickIntervalMs: 200,
    now: () => '2026-10-08T10:00:01.000Z',
  }).runTickOnce();
  return seen;
}

function finalize(handoff_action_id: string) {
  const handle = makeSqlJsHandle(db);
  const projected = buildFinalizeInput({ db: handle, handoff_action_id });
  if (projected.kind !== 'ok') throw new Error(`projection refused: ${projected.reason}`);
  let id = 0;
  return bindFinalizeTransaction({
    db: handle,
    salesRepo: bindSalesRepository(handle),
    outboxRepo: bindSaleSyncOutboxRepository(handle),
    allocator: bindSaleNumberAllocator(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-10-08T10:00:02.000Z',
    saleIdGenerator: () => `sale-${String(++id)}-${handoff_action_id}`,
    outboxRowIdGenerator: () => `ob-${String(++id)}-${handoff_action_id}`,
  }).finalize(projected.input);
}

const cashupPending = (): number =>
  createShiftCashupSources(makeSqlJsHandle(db)).pendingDrawerActivity(CASHUP_SCOPE)
    .unfinalizedSales;

async function paidAttempt(p: ReturnType<typeof boot>): Promise<string> {
  const s = await p.start({
    envelope_handoff_action_id: 'handoff-cart-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 1500,
    envelope_version: 'v1',
    idempotency_key: 'k-start',
  });
  if (s.kind !== 'ok') throw new Error(`start refused: ${s.reason}`);
  const a = await p.apply({
    payment_attempt_id: s.payment_attempt_id,
    tender_type: 'cash',
    amount_applied_minor: 1500,
    idempotency_key: 'k-apply',
  });
  if (a.kind !== 'ok') throw new Error(`apply refused: ${a.reason}`);
  return s.payment_attempt_id;
}

describe('RT-496 — atomic settlement + payment.settled audit', () => {
  it('CONTROL: a clean confirm writes the audit and freezes the selling display name', async () => {
    const p = boot();
    const id = await paidAttempt(p);
    expect(await p.confirm({ payment_attempt_id: id, idempotency_key: 'k-confirm' })).toEqual({
      kind: 'ok',
      settled_at: SETTLED_AT,
    });
    expect(settledAudits(id)).toBe(1);
    expect(p.attempts.findById(id)?.selling_operator_display_name).toBe('Test Operator');
    expect(listenerDispatches()).toEqual(['handoff-cart-1']);
    expect(cashupPending()).toBe(1);
  });

  it('AC1: a throw at the audit insert rolls the settlement back — neither row exists', async () => {
    const p = boot({ failOnSettledAudit: true });
    const id = await paidAttempt(p);
    await expect(
      p.confirm({ payment_attempt_id: id, idempotency_key: 'k-confirm' }),
    ).rejects.toThrow(/INJECTED/);
    const row = p.attempts.findById(id);
    expect(row?.state).toBe('started');
    expect(row?.settled_at).toBeNull();
    expect(row?.selling_operator_display_name).toBeNull();
    expect(count(`SELECT COUNT(*) FROM payment_action_outbox WHERE action_id = 'k-confirm'`)).toBe(
      0,
    );
    expect(settledAudits(id)).toBe(0);
    // No settled-without-audit state anywhere.
    expect(
      count(
        `SELECT COUNT(*) FROM payment_attempts a WHERE a.state = 'settled' AND NOT EXISTS (
           SELECT 1 FROM audit_events e WHERE e.action_category = 'payment.settled'
              AND json_extract(e.payload, '$.payment_attempt_id') = a.payment_attempt_id)`,
      ),
    ).toBe(0);
    // The tender line is untouched and still counts toward settlement.
    expect(
      count(
        `SELECT COUNT(*) FROM payment_tender_lines WHERE payment_attempt_id = ? AND state = 'applied'`,
        id,
      ),
    ).toBe(1);
  });

  it('AC4: a same-key retry after the fault settles with its audit and finalize is reachable', async () => {
    const p1 = boot({ failOnSettledAudit: true });
    const id = await paidAttempt(p1);
    await expect(
      p1.confirm({ payment_attempt_id: id, idempotency_key: 'k-confirm' }),
    ).rejects.toThrow(/INJECTED/);

    const p2 = boot(); // restart
    expect(await p2.confirm({ payment_attempt_id: id, idempotency_key: 'k-confirm' })).toEqual({
      kind: 'ok',
      settled_at: SETTLED_AT,
    });
    expect(settledAudits(id)).toBe(1);
    expect(listenerDispatches()).toEqual(['handoff-cart-1']);
    // A second replay is a pure replay: no second audit.
    expect(await p2.confirm({ payment_attempt_id: id, idempotency_key: 'k-confirm' })).toEqual({
      kind: 'ok',
      settled_at: SETTLED_AT,
    });
    expect(settledAudits(id)).toBe(1);
  });

  it('AC3 + AC6: one Sale per handoff; the cart stays paid and a new attempt is refused', async () => {
    const p = boot();
    const id = await paidAttempt(p);
    await p.confirm({ payment_attempt_id: id, idempotency_key: 'k-confirm' });

    expect(finalize('handoff-cart-1').kind).toBe('finalized');
    expect(finalize('handoff-cart-1').kind).toBe('finalized_idempotent');
    expect(
      count(`SELECT COUNT(*) FROM sales WHERE envelope_handoff_action_id = 'handoff-cart-1'`),
    ).toBe(1);
    expect(listenerDispatches()).toEqual([]);
    expect(cashupPending()).toBe(0);

    expect(bindCartPaymentStatus(p.handle)('cart-1')).toBe('settled');
    expect(
      await p.start({
        envelope_handoff_action_id: 'handoff-cart-1',
        envelope_cart_id: 'cart-1',
        envelope_subtotal_minor: 1500,
        envelope_version: 'v1',
        idempotency_key: 'k-start-2',
      }),
    ).toEqual({ kind: 'refused', reason: 'attempt_terminal' });
  });
});

describe('RT-496 — migration 0051', () => {
  it('adds a nullable, default-free selling_operator_display_name to payment_attempts', () => {
    const cols = db.exec(`PRAGMA table_info(payment_attempts)`)[0]?.values ?? [];
    const col = cols.find((c) => c[1] === 'selling_operator_display_name');
    // [cid, name, type, notnull, dflt_value, pk]
    expect(col?.slice(2)).toEqual(['TEXT', 0, null, 0]);
  });
});

describe('RT-496 — stranded settled attempts', () => {
  it('AC2 (attributable): the reconciler emits the audit once; dispatch once; cash-up held until finalized', () => {
    seedStrand({ id: 'pa-strand', cart: 'cart-s', handoff: 'handoff-s', displayName: 'Mona' });
    // Before healing, the strand already holds the cash-up close.
    expect(cashupPending()).toBe(1);

    const first = boot().reconciler.reconcile(SCOPE);
    expect(first).toEqual({ healed: ['pa-strand'], unattributable: [] });
    expect(boot().reconciler.reconcile(SCOPE)).toEqual({ healed: [], unattributable: [] });
    expect(settledAudits('pa-strand')).toBe(1);

    const payload = JSON.parse(
      db.exec(`SELECT payload FROM audit_events WHERE action_category = 'payment.settled'`)[0]
        ?.values[0]?.[0] as string,
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      payment_attempt_id: 'pa-strand',
      cart_id: 'cart-s',
      handoff_action_id: 'handoff-s',
      settled_at: '2026-10-07T08:01:00.000Z',
      attribution_operator_id: 'op-clerk-user-abc',
      selling_operator_display_name: 'Mona',
      reconciled_at: '2026-10-08T12:00:00.000Z',
    });
    // The selling user id is not durable, so it is never guessed.
    expect(payload).not.toHaveProperty('selling_user_id');

    expect(cashupPending()).toBe(1);
    expect(listenerDispatches()).toEqual(['handoff-s']);
    expect(finalize('handoff-s').kind).toBe('finalized');
    expect(listenerDispatches()).toEqual([]);
    expect(cashupPending()).toBe(0);
    expect(count(`SELECT COUNT(*) FROM sales WHERE envelope_handoff_action_id = 'handoff-s'`)).toBe(
      1,
    );
  });

  it('AC2 (legacy, unattributable): flagged and held — no audit, no Sale, close not allowed', () => {
    seedStrand({ id: 'pa-legacy', cart: 'cart-l', handoff: 'handoff-l', displayName: null });

    expect(boot().reconciler.reconcile(SCOPE)).toEqual({
      healed: [],
      unattributable: ['pa-legacy'],
    });
    expect(boot().reconciler.reconcile(SCOPE)).toEqual({
      healed: [],
      unattributable: ['pa-legacy'],
    });
    expect(
      count(`SELECT COUNT(*) FROM audit_events WHERE action_category = 'payment.settled'`),
    ).toBe(0);
    expect(listenerDispatches()).toEqual([]);
    expect(count(`SELECT COUNT(*) FROM sales`)).toBe(0);
    // Financial visibility: the money stays counted as in-flight drawer cash.
    expect(cashupPending()).toBe(1);
  });

  it('a strand on another terminal is neither healed nor counted here', () => {
    seedStrand({ id: 'pa-other', cart: 'cart-o', handoff: 'handoff-o', displayName: 'Mona' });
    db.run(
      `UPDATE payment_attempts SET terminal_id = 'terminal-OTHER' WHERE payment_attempt_id = 'pa-other'`,
    );
    expect(boot().reconciler.reconcile(SCOPE)).toEqual({ healed: [], unattributable: [] });
    expect(cashupPending()).toBe(0);
  });

  it('a same-key confirm replay on an attributable strand re-emits the missing audit once', async () => {
    seedStrand({ id: 'pa-1', cart: 'cart-r', handoff: 'handoff-r', displayName: 'Mona' });
    // The confirm outbox row a pre-fix settle left behind (same hash the
    // handler computes for this request), so the retry takes the replay path.
    db.run(
      `INSERT INTO payment_action_outbox (action_id, payment_attempt_id, tender_line_id, action_kind,
         action_payload_hash, acting_operator_id, created_at)
       VALUES ('k-replay', 'pa-1', NULL, 'payment.confirm', ?, 'op-clerk-user-abc',
         '2026-10-07T08:01:00.000Z')`,
      [hashActionPayload('payment.confirm', attemptActionPayload({ payment_attempt_id: 'pa-1' }))],
    );
    const p = boot();

    expect(await p.confirm({ payment_attempt_id: 'pa-1', idempotency_key: 'k-replay' })).toEqual({
      kind: 'ok',
      settled_at: '2026-10-07T08:01:00.000Z',
    });
    expect(settledAudits('pa-1')).toBe(1);
    await p.confirm({ payment_attempt_id: 'pa-1', idempotency_key: 'k-replay' });
    expect(settledAudits('pa-1')).toBe(1);
    expect(listenerDispatches()).toEqual(['handoff-r']);
  });
});
