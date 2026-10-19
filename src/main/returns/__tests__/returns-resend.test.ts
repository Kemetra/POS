/**
 * RT-196 S1 — the per-row resend (main-process service method).
 *
 * A manager or admin resends ONE unresolved return, directly (C6, audited):
 *   • the identical journaled bytes under the same Idempotency-Key (AC8), sent
 *     now — not delayed by the resolver's per-row backoff;
 *   • `confirmed` only by the dispatcher's own match check; never locally;
 *   • a confirmed / paid-out / refused row is `already_resolved`: nothing is sent;
 *   • the row must be on this terminal; the id must be a canonical UUID;
 *   • `sale.return.resend_requested` is attributed to the REQUESTING operator;
 *   • the answer is withheld if the session changed while it was awaited.
 *
 * `resend` is deliberately NOT on the `returns.*` bridge (`service`): a bridge
 * channel is a §A4 review item, prepared in the RT-196 notes, not wired here.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { nn } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  LINE_A,
  SALE_NUMBER,
  categories,
  errorBody,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  secondsAfterNow,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

afterEach(() => {
  h.close();
});

const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };

function harness(): ReturnsHarness {
  h = returnsHarness();
  seedSyncedSale(h.db);
  return h;
}

async function unknownReturn(): Promise<string> {
  h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`unknownReturn: ${res.kind}`);
  return res.ret.returnId;
}

describe('RT-196 S1 — returns resend', () => {
  it('is not part of the returns bridge (no new IPC surface in S1)', () => {
    harness();
    expect('resend' in h.service).toBe(false);
    expect(typeof h.resend).toBe('function');
  });

  it('sends the identical bytes under the same key, at once, and confirms through the dispatcher', async () => {
    harness();
    const returnId = await unknownReturn();
    // One second later: inside the row's own backoff, which a resend ignores.
    h.state.now = secondsAfterNow(1);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

    const res = await h.resend({ returnId });

    expect(res).toMatchObject({ kind: 'confirmed', ret: { state: 'confirmed' } });
    const [first, second] = h.backend.returnCalls();
    expect(second?.body).toBe(first?.body);
    expect(second?.headers['Idempotency-Key']).toBe(first?.headers['Idempotency-Key']);
    expect(categories(h.audits)).toEqual([
      'sale.return.attempted',
      'sale.return.attempt_unknown',
      'sale.return.resend_requested',
      'sale.return.confirmed',
      'sale.return.payout_ready',
    ]);
  });

  it('a resend the server still cannot answer stays unknown and records operation=resend', async () => {
    harness();
    const returnId = await unknownReturn();
    h.backend.onReturn = () => jsonResponse(503, errorBody('unavailable'));

    const res = await h.resend({ returnId });

    expect(res).toMatchObject({
      kind: 'unconfirmed',
      ret: { state: 'unknown', attemptCount: 2, lastCause: 'server_5xx' },
    });
    const last = h.audits.at(-1);
    expect(last?.action_category).toBe('sale.return.attempt_unknown');
    expect(last?.payload).toMatchObject({
      attempt_no: 2,
      cause: 'server_5xx',
      operation: 'resend',
    });
  });

  it('resend_requested is attributed to the requesting operator, ids only', async () => {
    harness();
    const returnId = await unknownReturn();
    h.state.role = 'admin';
    h.backend.onReturn = () => jsonResponse(503, errorBody('unavailable'));

    await h.resend({ returnId });

    const event = h.audits.find((e) => e.action_category === 'sale.return.resend_requested');
    expect(event?.acting_operator_id).toBe('op-admin');
    expect(nn(h.repo.read(returnId)).operatorId).toBe('op-manager');
    expect(event?.payload).toEqual({ return_id: returnId });
  });

  it.each(['confirmed', 'refused'] as const)(
    'a %s row is already_resolved: nothing is sent',
    async (state) => {
      harness();
      if (state === 'refused')
        h.backend.onReturn = () => jsonResponse(409, errorBody('over_return'));
      const res = await h.service.submit(ONE_A);
      const returnId = nn(res.ret).returnId;
      const before = h.backend.returnCalls().length;

      await expect(h.resend({ returnId })).resolves.toMatchObject({
        kind: 'refused',
        reason: 'already_resolved',
        ret: { state },
      });

      expect(h.backend.returnCalls()).toHaveLength(before);
      expect(h.audits.some((e) => e.action_category === 'sale.return.resend_requested')).toBe(
        false,
      );
    },
  );

  it('a credit-sale 403 on a resend refuses the row (OD-196-9), never leaves it unknown', async () => {
    harness();
    const returnId = await unknownReturn();
    h.backend.onReturn = () => jsonResponse(403, errorBody('credit_sale_reversal_restricted'));

    const res = await h.resend({ returnId });

    expect(res).toMatchObject({
      kind: 'refused',
      reason: 'credit_sale_reversal_restricted',
      ret: { state: 'refused' },
    });
  });

  it('the operator-guard 403 on a resend leaves the row unknown', async () => {
    harness();
    const returnId = await unknownReturn();
    h.backend.onReturn = () => jsonResponse(403, errorBody('forbidden'));

    await expect(h.resend({ returnId })).resolves.toMatchObject({
      kind: 'unconfirmed',
      ret: { state: 'unknown', lastCause: 'pre_replay_403' },
    });
  });

  it('refuses an unknown id, a non-UUID, and a return of another terminal', async () => {
    harness();
    const returnId = await unknownReturn();
    await expect(
      h.resend({ returnId: '0190f5a2-7b3c-7d4e-8f90-0000000000ee' }),
    ).resolves.toMatchObject({ kind: 'refused', reason: 'return_not_found' });
    await expect(h.resend({ returnId: "x' OR 1=1" })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'invalid_input',
    });
    h.state.terminalId = 'term-2';
    const before = h.backend.returnCalls().length;
    await expect(h.resend({ returnId })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'return_not_found',
    });
    expect(h.backend.returnCalls()).toHaveLength(before);
  });

  it.each([
    ['a cashier', 'cashier', 'role_denied'],
    ['a locked session', 'manager', 'session_changed'],
  ] as const)('%s cannot resend', async (label, role, reason) => {
    harness();
    const returnId = await unknownReturn();
    h.state.role = role;
    h.state.locked = label === 'a locked session';
    const before = h.backend.returnCalls().length;

    await expect(h.resend({ returnId })).resolves.toMatchObject({ kind: 'refused', reason });

    expect(h.backend.returnCalls()).toHaveLength(before);
  });

  it('with the feature off, nothing runs', async () => {
    harness();
    const returnId = await unknownReturn();
    h.state.enabled = false;
    await expect(h.resend({ returnId })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'feature_disabled',
    });
  });

  it('withholds the answer when the session changed while the POST was awaited', async () => {
    harness();
    const returnId = await unknownReturn();
    h.backend.onReturn = (call, backend) => {
      h.state.locked = true;
      return backend.recordIdempotently(call);
    };

    const res = await h.resend({ returnId });

    expect(res).toEqual({ kind: 'refused', reason: 'session_changed', ret: null });
    // The return itself is confirmed locally; the next eligible operator sees it.
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });

  it('after shutdown answers shutting_down and touches nothing', async () => {
    harness();
    const returnId = await unknownReturn();
    h.stop();
    const before = h.audits.length;
    await expect(h.resend({ returnId })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'shutting_down',
    });
    expect(h.audits).toHaveLength(before);
  });
});
