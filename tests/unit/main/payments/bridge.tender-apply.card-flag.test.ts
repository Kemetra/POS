/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.payments-start.test.ts for rationale.
 */
/**
 * RT-700 (P-26-1, OD-26-1) — `tender.apply` and the card-tender flag.
 *
 * With `POS_PULSE_FEATURE_CARD_TENDER` off, main refuses a card
 * `tender.apply` with `card_tender_disabled` and audits `tender.refused`;
 * nothing is recorded (no idempotency reservation, no FSM call, no line).
 * Cash and voucher are unchanged. With the flag on, card behaves as before.
 * The last block drives the real handler through the IPC registrar, the path
 * a compromised or stale renderer would take.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { registerPaymentsHandlers } from '../../../../src/main/ipc/payments.js';
import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import { REFUSAL_REASONS } from '../../../../src/shared/payments/types.js';
import { TENDER_IPC_CHANNELS } from '../../../../src/shared/payments/channels.js';
import type { TenderApplyRequest } from '../../../../src/shared/bridge-api.js';

import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLinesRepoDouble,
  makeSession,
  makeSessionSource,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';

const NOW = '2026-10-18T10:00:00.000Z';

function request(overrides: Partial<TenderApplyRequest> = {}): TenderApplyRequest {
  return {
    payment_attempt_id: 'pa-1',
    tender_type: 'external_card_terminal',
    amount_applied_minor: 1500,
    external_reference: 'AB12XY',
    idempotency_key: 'idem-card-1',
    ...overrides,
  };
}

function setup(opts: { cardEnabled: boolean; session?: boolean }) {
  const fsm = makeTenderLineFsmDouble();
  const idempotency = makeIdempotencyHelperDouble();
  const auditEmitter = makeAuditEmitterDouble();
  const handler = createTenderApplyHandler({
    isCardTenderEnabled: () => opts.cardEnabled,
    getCurrentSession: makeSessionSource(opts.session === false ? null : makeSession())
      .getCurrentSession,
    attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
    linesRepo: makeLinesRepoDouble(),
    tenderLineFsm: fsm,
    idempotency,
    auditEmitter,
    uuid: () => 'tl-1',
    clock: () => new Date(NOW),
  });
  return { handler, fsm, idempotency, auditEmitter };
}

describe('RT-700 — card tender flag off', () => {
  it('refuses a card apply with card_tender_disabled and records nothing', async () => {
    const { handler, fsm, idempotency } = setup({ cardEnabled: false });
    const result = await handler(request());
    expect(result).toEqual({ kind: 'refused', reason: 'card_tender_disabled' });
    expect(fsm.apply).not.toHaveBeenCalled();
    expect(idempotency.checkOrReserve).not.toHaveBeenCalled();
  });

  it('audits one tender.refused row that names the type and reason, never the reference', async () => {
    const { handler, auditEmitter } = setup({ cardEnabled: false });
    await handler(request());
    expect(auditEmitter.emitTenderApplied).not.toHaveBeenCalled();
    expect(auditEmitter.emitTenderRefused).toHaveBeenCalledTimes(1);
    expect(auditEmitter.emitTenderRefused).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_attempt_id: 'pa-1',
        tender_type: 'external_card_terminal',
        refusal_reason: 'card_tender_disabled',
        refused_at: NOW,
      }),
    );
    const logged = JSON.stringify(vi.mocked(auditEmitter.emitTenderRefused).mock.calls);
    expect(logged).not.toContain('AB12XY');
    expect(logged).not.toContain('amount_applied_minor');
  });

  it('refuses even a replayed card key (fail closed)', async () => {
    const fsm = makeTenderLineFsmDouble();
    const handler = createTenderApplyHandler({
      isCardTenderEnabled: () => false,
      getCurrentSession: makeSessionSource(makeSession()).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay', tender_line_id: 'tl-old' }),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-1',
      clock: () => new Date(NOW),
    });
    expect(await handler(request())).toEqual({ kind: 'refused', reason: 'card_tender_disabled' });
    expect(fsm.apply).not.toHaveBeenCalled();
  });

  it('keeps the session gate first: no session still answers no_session, with no audit', async () => {
    const { handler, auditEmitter } = setup({ cardEnabled: false, session: false });
    expect(await handler(request())).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(auditEmitter.emitTenderRefused).not.toHaveBeenCalled();
  });

  it('leaves cash unchanged', async () => {
    const { handler, fsm, auditEmitter } = setup({ cardEnabled: false });
    vi.mocked(fsm.apply).mockReturnValueOnce({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: NOW,
    });
    const result = await handler(
      request({ tender_type: 'cash', external_reference: undefined, idempotency_key: 'k-cash' }),
    );
    expect(result).toEqual({ kind: 'ok', tender_line_id: 'tl-1', applied_at: NOW });
    expect(fsm.apply).toHaveBeenCalledTimes(1);
    expect(auditEmitter.emitTenderApplied).toHaveBeenCalledTimes(1);
  });

  it('leaves voucher on its own path (the card flag is not consulted)', async () => {
    const { handler, fsm } = setup({ cardEnabled: false });
    const result = await handler(
      request({
        tender_type: 'internal_voucher',
        external_reference: undefined,
        voucher_code: 'V-ABC',
        idempotency_key: 'k-voucher',
      }),
    );
    // No validateVoucher dep in this setup: the voucher branch answers its own refusal.
    expect(result).toEqual({ kind: 'refused', reason: 'tender_not_yet_supported' });
    expect(fsm.apply).not.toHaveBeenCalled();
  });
});

describe('RT-700 — card tender flag on', () => {
  it('passes the card apply to the FSM and audits tender.applied, as before', async () => {
    const { handler, fsm, auditEmitter } = setup({ cardEnabled: true });
    vi.mocked(fsm.apply).mockReturnValueOnce({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: NOW,
    });
    const result = await handler(request());
    expect(result).toEqual({ kind: 'ok', tender_line_id: 'tl-1', applied_at: NOW });
    expect(auditEmitter.emitTenderApplied).toHaveBeenCalledTimes(1);
    expect(auditEmitter.emitTenderRefused).not.toHaveBeenCalled();
  });
});

describe('RT-700 — direct IPC call', () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

  function registerWith(cardEnabled: boolean) {
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (channel: string, fn: Handler): void => {
        handlers.set(channel, fn);
      },
    } as unknown as IpcMain;
    const parts = setup({ cardEnabled });
    const unused = vi.fn(() => Promise.reject(new Error('not under test')));
    registerPaymentsHandlers(ipcMain, {
      paymentsStart: unused,
      paymentsConfirm: unused,
      paymentsCancel: unused,
      paymentsSubscribe: unused,
      paymentsRead: unused,
      tenderApply: parts.handler,
      tenderReverse: unused,
      tenderRead: unused,
      paymentsForceFail: unused,
    });
    const apply = handlers.get(TENDER_IPC_CHANNELS.APPLY);
    if (apply === undefined) throw new Error('missing tender.apply');
    return { apply, ...parts };
  }

  it('a card tender.apply invoked straight on the channel is refused while the flag is off', async () => {
    const { apply, fsm } = registerWith(false);
    const result = await apply({} as IpcMainInvokeEvent, request());
    expect(result).toEqual({ kind: 'refused', reason: 'card_tender_disabled' });
    expect(fsm.apply).not.toHaveBeenCalled();
  });

  it('the same call reaches the FSM when the flag is on', async () => {
    const { apply, fsm } = registerWith(true);
    vi.mocked(fsm.apply).mockReturnValueOnce({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: NOW,
    });
    const result = await apply({} as IpcMainInvokeEvent, request());
    expect(result).toMatchObject({ kind: 'ok' });
    expect(fsm.apply).toHaveBeenCalledTimes(1);
  });
});

describe('RT-700 — closed refusal enum', () => {
  it('lists card_tender_disabled exactly once', () => {
    expect(REFUSAL_REASONS.filter((r) => r === 'card_tender_disabled')).toHaveLength(1);
  });
});
