/**
 * RT-700 (P-26-1, OD-26-1 option A) — the card-tender flag, fail-closed in main.
 *
 * With `POS_PULSE_FEATURE_CARD_TENDER` off, a `tender.apply` for
 * `external_card_terminal` is refused `card_tender_disabled` and audited as
 * `tender.refused`, and nothing is persisted: no tender line, no outbox row.
 * The tender type first crosses the bridge at `tender.apply`; `payments.start`
 * stays tender-neutral. Cash and voucher are unchanged. With the flag on the
 * card path behaves as before.
 *
 * The calls go through the registered `tender.apply` IPC channel (the same
 * registrar `index.ts` uses), over the real handlers, FSMs, repositories and
 * idempotency helper on an in-memory SQLite database. A direct IPC call is the
 * path a renderer that ignores the hidden tile would take.
 */

import { describe, expect, it } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { createPaymentsStartHandler } from '../../../../src/main/payments/handlers/payments-start.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import { registerPaymentsHandlers } from '../../../../src/main/ipc/payments.js';
import {
  PAYMENTS_IPC_CHANNELS,
  TENDER_IPC_CHANNELS,
} from '../../../../src/shared/payments/channels.js';
import type {
  PaymentsStartResponse,
  TenderApplyResponse,
} from '../../../../src/shared/bridge-api.js';
import type { ValidateVoucherOutcome } from '../../../../src/main/payments/voucher-authority-client/validate.js';
import { makeAuditEmitterDouble, makeSession } from './__fixtures__/bridge-handler-deps.js';
import { bindRealPaymentsCore, freshMigratedDbPerTest } from './__fixtures__/real-payments-core.js';

const currentDb = freshMigratedDbPerTest();

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const validateVoucher = (): Promise<ValidateVoucherOutcome> =>
  Promise.resolve({
    kind: 'validated',
    applied_amount_minor: 1000,
    intent_expires_at: '2026-10-18T10:05:00.000Z',
    redemption_intent_token: 'opaque-intent-token',
  });

/** `cardTender` is read on every call, as `index.ts` re-reads the env. */
function build(flag: { cardTender: boolean }) {
  const { attempts, lines, outbox, tenderLineFsm, paymentAttemptFsm, idempotency } =
    bindRealPaymentsCore(currentDb());
  const auditEmitter = makeAuditEmitterDouble();
  let n = 0;
  const shared = {
    getCurrentSession: () => makeSession(),
    attemptsRepo: attempts,
    idempotency,
    auditEmitter,
    clock: (): Date => new Date('2026-10-18T10:00:00.000Z'),
    uuid: (): string => `uuid-${String(++n)}`,
  };
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  const unused = (): Promise<never> => Promise.reject(new Error('not under test'));
  registerPaymentsHandlers(ipcMain, {
    paymentsStart: createPaymentsStartHandler({
      ...shared,
      paymentAttemptFsm,
      checkCartForPayment: () => ({ kind: 'ok' }),
      attemptHasLiveTender: () => false,
    }),
    tenderApply: createTenderApplyHandler({
      ...shared,
      linesRepo: lines,
      tenderLineFsm,
      validateVoucher,
      isCardTenderEnabled: () => flag.cardTender,
    }),
    paymentsConfirm: unused,
    paymentsCancel: unused,
    paymentsSubscribe: unused,
    paymentsRead: unused,
    tenderReverse: unused,
    tenderRead: unused,
  });
  const invoke = (channel: string, request: unknown): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (fn === undefined) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(fn({} as IpcMainInvokeEvent, request));
  };
  return {
    auditEmitter,
    lines,
    outbox,
    start: (cart = 'cart-1') =>
      invoke(PAYMENTS_IPC_CHANNELS.START, {
        envelope_handoff_action_id: `handoff-${cart}`,
        envelope_cart_id: cart,
        envelope_subtotal_minor: 1500,
        envelope_version: 'v1',
        idempotency_key: `k-start-${cart}`,
      }) as Promise<PaymentsStartResponse>,
    apply: (request: Record<string, unknown>) =>
      invoke(TENDER_IPC_CHANNELS.APPLY, request) as Promise<TenderApplyResponse>,
  };
}

type Stack = ReturnType<typeof build>;

async function startAttempt(s: Stack): Promise<string> {
  const r = await s.start();
  if (r.kind !== 'ok') throw new Error(`start refused: ${r.reason}`);
  return r.payment_attempt_id;
}

function cardRequest(attempt: string, key = 'k-card') {
  return {
    payment_attempt_id: attempt,
    tender_type: 'external_card_terminal',
    amount_applied_minor: 1500,
    external_reference: 'A1B2C3',
    idempotency_key: key,
  };
}

describe('RT-700 — card-tender flag off (default): main refuses a card tender', () => {
  it('payments.start stays tender-neutral: an attempt starts with the flag off', async () => {
    const s = build({ cardTender: false });
    const r = await s.start();
    expect(r.kind).toBe('ok');
  });

  it('a direct IPC tender.apply for external_card_terminal is refused card_tender_disabled', async () => {
    const s = build({ cardTender: false });
    const attempt = await startAttempt(s);
    expect(await s.apply(cardRequest(attempt))).toEqual({
      kind: 'refused',
      reason: 'card_tender_disabled',
    });
  });

  it('persists nothing on the refusal: no tender line and no outbox row', async () => {
    const s = build({ cardTender: false });
    const attempt = await startAttempt(s);
    await s.apply(cardRequest(attempt));
    expect(s.lines.findByAttempt(attempt)).toEqual([]);
    expect(s.outbox.findByActionId('k-card')).toBeUndefined();
  });

  it('audits the refusal as tender.refused with the typed reason and no card reference', async () => {
    const s = build({ cardTender: false });
    const attempt = await startAttempt(s);
    await s.apply(cardRequest(attempt));
    const refused = s.auditEmitter.captured.filter((e) => e.action_category === 'tender.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      payment_attempt_id: attempt,
      attribution_operator_id: 'op-clerk-user-abc',
      payload: {
        payment_attempt_id: attempt,
        tender_type: 'external_card_terminal',
        refusal_reason: 'card_tender_disabled',
      },
    });
    expect(JSON.stringify(refused[0])).not.toContain('A1B2C3');
  });

  it('a retry with the same key is refused again; nothing is ever recorded', async () => {
    const s = build({ cardTender: false });
    const attempt = await startAttempt(s);
    await s.apply(cardRequest(attempt));
    expect(await s.apply(cardRequest(attempt))).toEqual({
      kind: 'refused',
      reason: 'card_tender_disabled',
    });
    expect(s.lines.findByAttempt(attempt)).toEqual([]);
  });

  it('the session gate still runs first: no session answers no_session, not the flag', async () => {
    const s = build({ cardTender: false });
    const attempt = await startAttempt(s);
    const noSession = createTenderApplyHandler({
      getCurrentSession: () => null,
      attemptsRepo: { findById: () => undefined },
      linesRepo: { findByAttempt: () => [] },
      tenderLineFsm: { apply: () => ({ kind: 'refused', reason: 'internal_error' }) },
      idempotency: { checkOrReserve: () => ({ kind: 'mismatch' }) },
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'u',
      clock: () => new Date(),
      isCardTenderEnabled: () => false,
    });
    expect(
      await noSession({
        payment_attempt_id: attempt,
        tender_type: 'external_card_terminal',
        amount_applied_minor: 1500,
        idempotency_key: 'k',
      }),
    ).toEqual({ kind: 'refused', reason: 'no_session' });
  });

  it.each([
    [
      'cash applies (with change due)',
      { tender_type: 'cash', amount_applied_minor: 2000, idempotency_key: 'k-cash' },
      { kind: 'ok', change_due_minor: 500 },
    ],
    [
      'voucher applies through V-A',
      {
        tender_type: 'internal_voucher',
        amount_applied_minor: 1000,
        voucher_code: 'VOUCHER-1',
        idempotency_key: 'k-voucher',
      },
      { kind: 'ok' },
    ],
  ])('other tenders are unchanged with the flag off: %s', async (_name, request, expected) => {
    const s = build({ cardTender: false });
    const attempt = await startAttempt(s);
    expect(await s.apply({ payment_attempt_id: attempt, ...request })).toMatchObject(expected);
  });

  it('fails closed when the flag reader is not wired', async () => {
    const core = bindRealPaymentsCore(currentDb());
    const s = build({ cardTender: false });
    const attempt = await startAttempt(s);
    const unwired = createTenderApplyHandler({
      getCurrentSession: () => makeSession(),
      attemptsRepo: core.attempts,
      linesRepo: core.lines,
      tenderLineFsm: core.tenderLineFsm,
      idempotency: core.idempotency,
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'uuid-unwired',
      clock: () => new Date('2026-10-18T10:00:00.000Z'),
    });
    expect(
      await unwired({
        payment_attempt_id: attempt,
        tender_type: 'external_card_terminal',
        amount_applied_minor: 1500,
        external_reference: 'A1B2C3',
        idempotency_key: 'k-unwired',
      }),
    ).toEqual({ kind: 'refused', reason: 'card_tender_disabled' });
  });
});

describe('RT-700 — card-tender flag on: card behaves as before', () => {
  it('a card tender applies and records its line', async () => {
    const s = build({ cardTender: true });
    const attempt = await startAttempt(s);
    const r = await s.apply(cardRequest(attempt));
    expect(r.kind).toBe('ok');
    expect(s.lines.findByAttempt(attempt)).toHaveLength(1);
    expect(s.auditEmitter.captured.map((e) => e.action_category)).toContain('tender.applied');
  });

  it('a same-key replay answers the recorded line even after the flag is turned off', async () => {
    const flag = { cardTender: true };
    const s = build(flag);
    const attempt = await startAttempt(s);
    const first = await s.apply(cardRequest(attempt));
    flag.cardTender = false;
    expect(await s.apply(cardRequest(attempt))).toEqual(first);
    // A new card tender is refused once the flag is off.
    expect(await s.apply(cardRequest(attempt, 'k-card-2'))).toEqual({
      kind: 'refused',
      reason: 'card_tender_disabled',
    });
  });
});
