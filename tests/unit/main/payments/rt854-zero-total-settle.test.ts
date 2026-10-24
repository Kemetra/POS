/**
 * RT-854 (RT-699 I1, doc 28 §11.3, OZ-1 = Z-A) — a fully discounted sale
 * completes with no tender. Real stack over sql.js with every migration:
 *
 *   • `payments.start` takes the envelope's net `total_due_minor` = 0, and
 *     refuses the gross;
 *   • a cash tender at 0 due is still refused (RT-339 is kept: Z-B not taken);
 *   • `payments.confirm` with no tender line settles (Σ applied 0 = due 0),
 *     with a `payment.settled` audit carrying an empty tender breakdown;
 *   • finalize writes the Sale with total 0 and an empty tender summary;
 *   • cash-up counts the sale and expects no extra cash;
 *   • the drawer gate sees no cash tender, so no kick (suppressed).
 *
 * No guard refuses the no-tender settle: the stop condition of RT-854 did not
 * fire. The capture rule (one `cash` 0 tender) is RT-858's, not tested here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createPaymentsConfirmHandler } from '../../../../src/main/payments/handlers/payments-confirm.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import {
  createPaymentAuditEmitter,
  type PaymentAuditEvent,
} from '../../../../src/main/payments/audit-emitter.js';
import { bindCartPaymentEligibility } from '../../../../src/main/payments/cart-payment-eligibility.js';
import { createSettlementCommitter } from '../../../../src/main/payments/settlement-commit.js';
import { createSettledAuditReconciler } from '../../../../src/main/payments/settled-audit-reconciler.js';
import { bindAuditEventsStoreDb } from '../../../../src/main/audit/audit-events-store.js';
import { buildFinalizeInput } from '../../../../src/main/sales/finalize-dispatch.js';
import { bindFinalizeTransaction } from '../../../../src/main/sales/finalize-transaction.js';
import { bindSalesRepository } from '../../../../src/main/sales/repositories/sales.repository.js';
import { bindSaleSyncOutboxRepository } from '../../../../src/main/sync-outbox/sale-sync-outbox.repository.js';
import { bindSaleNumberAllocator } from '../../../../src/main/sales/sale-number-allocator.js';
import { createSaleAuditEmitter } from '../../../../src/main/sales/audit-emitter.js';
import { createShiftCashupSources } from '../../../../src/main/shift-cashup/shift-cashup-sources.js';
import { computeCashup } from '../../../../src/main/shift-cashup/shift-cashup-calculator.js';
import { hasCashTender } from '../../../../src/main/drawer/drawer-kick.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import { makeSession } from './__fixtures__/bridge-handler-deps.js';
import { bindRealPaymentsCore, freshMigratedDbPerTest } from './__fixtures__/real-payments-core.js';

const TENANT = 'tenant-1';
const BRANCH = 'branch-1';
const TERMINAL = 'terminal-1';
const SETTLED_AT = '2026-10-24T10:00:00.000Z';
const GROSS = 9000;
const HANDOFF = 'handoff-cart-1';

const currentDb = freshMigratedDbPerTest();
let db: SqlJsDatabase;
beforeEach(() => {
  db = currentDb();
  db.run(
    `INSERT INTO terminal_assignment
       (id, tenant_id, branch_id, terminal_id, terminal_label, paired_at,
        branch_name, branch_address, tenant_tax_registration_id)
     VALUES (1, ?, ?, ?, 'TERM-01', 1716800000, 'Maadi', '12 Road 9', 'TRN-1')`,
    [TENANT, BRANCH, TERMINAL],
  );
  seedFullyDiscountedCart();
});

/** RT-856: the RT-854 add's audit payload, which finalize freezes onto the line. */
const DISCOUNT_AUDIT_PAYLOAD = {
  cart_id: 'cart-1',
  cart_line_id: 'line-1',
  placeholder_id: 'dp-1',
  approval_id: 'appr-1',
  reason_code: 'promotion',
  kind: 'percent',
  value: 100,
  amount_minor: GROSS,
};

/** A handed-off cart whose one line carries a manager-authorised 100% discount. */
function seedFullyDiscountedCart(): void {
  const envelope = {
    envelope_version: 'v1',
    cart_id: 'cart-1',
    operator_session_id: 'sess-1',
    owning_operator_id: 'op-clerk-user-abc',
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    lines: [
      {
        line_id: 'line-1',
        item_ref: 'SKU-001',
        display_name: 'Panadol Extra',
        quantity: 2,
        unit_price_minor: 4500,
        line_subtotal_minor: GROSS,
        note: null,
        version: 1,
        last_action_id: 'a1',
      },
    ],
    discount_placeholders: [
      {
        placeholder_id: 'dp-1',
        line_id: 'line-1',
        placeholder_kind: 'manual_pct_100',
        requires_manager_attribution: true,
        attribution_operator_id: 'mgr-1',
      },
    ],
    subtotal_minor: GROSS,
    discount_total_minor: GROSS,
    total_due_minor: 0,
    created_at: '2026-10-24T09:00:00.000Z',
    handoff_action_id: HANDOFF,
  };
  db.run(
    `INSERT INTO carts (
       cart_id, tenant_id, branch_id, terminal_id, owning_operator_id, operator_session_id,
       state, cart_subtotal_minor, created_at, updated_at, frozen_at, cancelled_at,
       cancellation_reason, handoff_envelope_json, last_action_id
     ) VALUES ('cart-1', ?, ?, ?, 'op-clerk-user-abc', 'sess-1', 'frozen_handed_off', ?,
       '2026-10-24T09:00:00.000Z', '2026-10-24T09:30:00.000Z', '2026-10-24T09:30:00.000Z',
       NULL, NULL, ?, 'a1')`,
    [TENANT, BRANCH, TERMINAL, GROSS, JSON.stringify(envelope)],
  );
  // The RT-614 trust row the add writes.
  db.run(
    `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
       acting_operator_id, session_id, shift_id, action_category, created_at,
       approving_supervisor_id, payload)
     VALUES ('evt-dp-1', ?, ?, ?, 'op-clerk-user-abc', 'sess-1', NULL,
       'cart.discount.manager_authorized', '2026-10-24T09:10:00.000Z', 'mgr-1', ?)`,
    [TENANT, BRANCH, TERMINAL, JSON.stringify(DISCOUNT_AUDIT_PAYLOAD)],
  );
}

function boot() {
  const { handle, attempts, lines, tenderLineFsm, paymentAttemptFsm, idempotency } =
    bindRealPaymentsCore(db);
  const store = bindAuditEventsStoreDb(handle);
  let n = 0;
  const write = (evt: PaymentAuditEvent): void => {
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
  const shared = {
    getCurrentSession: () => makeSession(),
    attemptsRepo: attempts,
    idempotency,
    auditEmitter,
    clock: () => new Date(SETTLED_AT),
  };
  const uuid = (): string => `uuid-${String(++n)}`;
  return {
    handle,
    attempts,
    lines,
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
      settlement: createSettlementCommitter({
        db: handle,
        paymentAttemptFsm,
        attemptsRepo: attempts,
        auditEmitter,
      }),
      settledAuditReconciler: createSettledAuditReconciler({
        db: handle,
        linesRepo: lines,
        auditEmitter,
        now: () => SETTLED_AT,
      }),
    }),
  };
}

function start(p: ReturnType<typeof boot>, amount: number) {
  return p.start({
    envelope_handoff_action_id: HANDOFF,
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: amount,
    envelope_version: 'v1',
    idempotency_key: `k-start-${String(amount)}`,
  });
}

function settledPayload(): Record<string, unknown> {
  const res = db.exec(
    `SELECT payload FROM audit_events WHERE action_category = 'payment.settled'`,
  )[0];
  return JSON.parse(String(res?.values[0]?.[0])) as Record<string, unknown>;
}

function finalize() {
  const handle = makeSqlJsHandle(db);
  const projected = buildFinalizeInput({ db: handle, handoff_action_id: HANDOFF });
  if (projected.kind !== 'ok') throw new Error(`projection refused: ${projected.reason}`);
  let id = 0;
  return bindFinalizeTransaction({
    db: handle,
    salesRepo: bindSalesRepository(handle),
    outboxRepo: bindSaleSyncOutboxRepository(handle),
    allocator: bindSaleNumberAllocator(handle),
    auditEmitter: createSaleAuditEmitter({ sink: { write: () => {} } }),
    now: () => '2026-10-24T10:00:02.000Z',
    saleIdGenerator: () => `sale-${String(++id)}`,
    outboxRowIdGenerator: () => `ob-${String(++id)}`,
  }).finalize(projected.input);
}

describe('RT-854 — a zero-total sale completes with no tender (OZ-1 = Z-A)', () => {
  it('payments.start takes the net 0 and refuses the gross', async () => {
    const p = boot();
    await expect(start(p, GROSS)).resolves.toEqual({
      kind: 'refused',
      reason: 'stale_handoff',
    });
    const s = await start(p, 0);
    expect(s.kind).toBe('ok');
    if (s.kind !== 'ok') return;
    expect(p.attempts.findById(s.payment_attempt_id)?.envelope_subtotal_minor).toBe(0);
  });

  it('a cash tender at 0 due is still refused (RT-339 kept)', async () => {
    const p = boot();
    const s = await start(p, 0);
    if (s.kind !== 'ok') throw new Error('start refused');
    const applied = await p.apply({
      payment_attempt_id: s.payment_attempt_id,
      tender_type: 'cash',
      amount_applied_minor: 0,
      idempotency_key: 'k-apply-0',
    });
    expect(applied.kind).toBe('refused');
    expect(p.lines.findByAttempt(s.payment_attempt_id)).toEqual([]);
  });

  it('confirm with no tender line settles, finalizes, counts in cash-up, and kicks no drawer', async () => {
    const p = boot();
    const s = await start(p, 0);
    if (s.kind !== 'ok') throw new Error('start refused');

    await expect(
      p.confirm({ payment_attempt_id: s.payment_attempt_id, idempotency_key: 'k-confirm' }),
    ).resolves.toEqual({ kind: 'ok', settled_at: SETTLED_AT });
    expect(p.attempts.findById(s.payment_attempt_id)?.state).toBe('settled');
    expect(settledPayload()['tender_lines']).toEqual([]);

    const finalized = finalize();
    expect(finalized.kind).toBe('finalized');
    const sale = db.exec(
      `SELECT subtotal_minor, total_change_due_minor, tender_lines_summary_json FROM sales`,
    )[0]?.values[0];
    expect(sale).toEqual([0, 0, '[]']);
    // RT-856: the free line keeps its gross and carries its frozen discount.
    const [line] = JSON.parse(
      String(db.exec(`SELECT lines_json FROM sales`)[0]?.values[0]?.[0]),
    ) as Array<Record<string, unknown>>;
    expect(line).toMatchObject({
      line_subtotal_minor: GROSS,
      discount: { kind: 'percent', value: 100, amount_minor: GROSS },
    });

    const sources = createShiftCashupSources(makeSqlJsHandle(db));
    const sales = sources.salesIn({
      scope: { tenantId: TENANT, branchId: BRANCH, terminalId: TERMINAL },
      window: { from: '2026-10-24T00:00:00.000Z', after: null, to: '2026-10-24T23:59:59.000Z' },
    });
    expect(sales).toHaveLength(1);
    const cashup = computeCashup({
      currencyCode: 'EGP',
      openingFloatMinor: 10_000,
      payInTotalMinor: 0,
      payOutTotalMinor: 0,
      sales,
      refunds: [],
    });
    expect(cashup).toMatchObject({
      saleCount: 1,
      cashSalesTotalMinor: 0,
      expectedCashMinor: 10_000,
    });

    // The drawer dispatcher suppresses a kick when the sale has no cash tender.
    const summary = String(sale?.[2]);
    expect(hasCashTender(summary)).toBe(false);
  });
});
