/* eslint-disable @typescript-eslint/unbound-method --
 * See bridge.payments-start.test.ts for rationale.
 */
/**
 * RT-437 (D-F2) — `tender.apply` passes the FSM's `cash_amount_out_of_range`
 * through unchanged, writes no audit event (owner decision 4) and logs one
 * `warn` line with the attempt id and never the amount. A line recorded before
 * the bound existed still replays with its original outcome.
 */
import { describe, expect, it, vi } from 'vitest';

import { createTenderApplyHandler } from '../../../../src/main/payments/handlers/tender-apply.js';
import {
  makeAttemptRow,
  makeAttemptsRepoDouble,
  makeAuditEmitterDouble,
  makeIdempotencyHelperDouble,
  makeLineRow,
  makeLinesRepoDouble,
  makeSession,
  makeSessionSource,
  makeTenderLineFsmDouble,
} from './__fixtures__/bridge-handler-deps.js';

const F02_AMOUNT = 622_100_000_001_100;

describe('RT-437 — tender.apply and the cash bound', () => {
  it('returns cash_amount_out_of_range, emits no audit, and logs one warn line without the amount', async () => {
    const fsm = makeTenderLineFsmDouble();
    fsm.apply.mockReturnValueOnce({ kind: 'refused', reason: 'cash_amount_out_of_range' });
    const auditEmitter = makeAuditEmitterDouble();
    const warn = vi.fn();
    const handler = createTenderApplyHandler({
      getCurrentSession: makeSessionSource(makeSession()).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter,
      uuid: () => 'tl-1',
      clock: () => new Date('2026-10-13T10:00:00.000Z'),
      logger: { warn },
    });

    const result = await handler({
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: F02_AMOUNT,
      idempotency_key: 'idem-1',
    });

    expect(result).toEqual({ kind: 'refused', reason: 'cash_amount_out_of_range' });
    expect(auditEmitter.emitTenderApplied).not.toHaveBeenCalled();
    expect(auditEmitter.emitTenderRefused).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: 'tender.apply.cash_out_of_range',
      payment_attempt_id: 'pa-1',
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(String(F02_AMOUNT));
    expect(logged).not.toContain('amount_applied_minor');
    expect(logged).not.toContain('change_due_minor');
  });

  it('logs nothing for other refusals', async () => {
    const fsm = makeTenderLineFsmDouble();
    fsm.apply.mockReturnValueOnce({ kind: 'refused', reason: 'attempt_fully_tendered' });
    const warn = vi.fn();
    const handler = createTenderApplyHandler({
      getCurrentSession: makeSessionSource(makeSession()).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble(),
      tenderLineFsm: fsm,
      idempotency: makeIdempotencyHelperDouble(),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-1',
      clock: () => new Date('2026-10-13T10:00:00.000Z'),
      logger: { warn },
    });
    await handler({
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: 1500,
      idempotency_key: 'idem-1',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a line recorded before the bound replays with its original outcome; the FSM is not called', async () => {
    const fsm = makeTenderLineFsmDouble();
    const handler = createTenderApplyHandler({
      getCurrentSession: makeSessionSource(makeSession()).getCurrentSession,
      attemptsRepo: makeAttemptsRepoDouble([makeAttemptRow()]),
      linesRepo: makeLinesRepoDouble([
        makeLineRow({
          tender_line_id: 'tl-old',
          tender_type: 'cash',
          amount_applied_minor: F02_AMOUNT,
          change_due_minor: F02_AMOUNT - 1500,
          applied_at: '2026-10-06T01:53:00.000Z',
          last_action_id: 'idem-old',
        }),
      ]),
      tenderLineFsm: fsm,
      idempotency: makeIdempotencyHelperDouble({ kind: 'replay', tender_line_id: 'tl-old' }),
      auditEmitter: makeAuditEmitterDouble(),
      uuid: () => 'tl-new',
      clock: () => new Date('2026-10-13T10:00:00.000Z'),
    });
    const result = await handler({
      payment_attempt_id: 'pa-1',
      tender_type: 'cash',
      amount_applied_minor: F02_AMOUNT,
      idempotency_key: 'idem-old',
    });
    expect(result).toEqual({
      kind: 'ok',
      tender_line_id: 'tl-old',
      applied_at: '2026-10-06T01:53:00.000Z',
      change_due_minor: F02_AMOUNT - 1500,
    });
    expect(fsm.apply).not.toHaveBeenCalled();
  });
});
