/**
 * RT-15 S2 — resolving returns whose outcome is not known (AC8, AC9).
 *
 *   • crash between send and confirm: Backend-Core recorded the return but the
 *     answer never reached the journal. The resolver re-sends the IDENTICAL
 *     request (same body bytes, same Idempotency-Key = externalId), the server
 *     replays it, and the replay confirms the return — once.
 *   • crash before send (`pending`): the resolver sends it.
 *   • a 200 provenance replay (different key window) also confirms.
 *   • a refusal on resend is final; an answer still lost stays `unknown`.
 *   • no credential → the background tick does nothing; passes are single-flight.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  LINE_A,
  SALE_NUMBER,
  SALE_REF,
  SCOPE,
  categories,
  errorBody,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  seedSyncedSale,
  type RecordedCall,
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
const ACTOR = { scope: SCOPE };

/** Submit once while the server RECORDS the return but the answer is lost. */
async function submitWithLostAnswer(): Promise<string> {
  h = returnsHarness();
  seedSyncedSale(h.db);
  h.backend.onReturn = (call, backend) => {
    backend.recordIdempotently(call);
    return Promise.reject(new TypeError('socket hang up'));
  };
  const res = await h.service.submit(ONE_A);
  expect(res).toMatchObject({ kind: 'unconfirmed', ret: { state: 'unknown' } });
  h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
  return res.kind === 'unconfirmed' ? res.ret.returnId : '';
}

function sameRequest(a: RecordedCall | undefined, b: RecordedCall | undefined): void {
  expect(b?.url).toBe(a?.url);
  expect(b?.body).toBe(a?.body);
  expect(b?.headers['Idempotency-Key']).toBe(a?.headers['Idempotency-Key']);
}

describe('returns resolver', () => {
  it('crash between send and confirm: the resend replays and confirms exactly once', async () => {
    const returnId = await submitWithLostAnswer();

    await expect(h.resolver.resolveOnce(ACTOR)).resolves.toEqual({
      confirmed: 1,
      refused: 0,
      unresolved: 0,
    });

    const [first, resend] = h.backend.returnCalls();
    sameRequest(first, resend);
    expect(h.backend.recorded.size).toBe(1);
    expect(h.repo.read(returnId)).toMatchObject({ state: 'confirmed', attemptCount: 2 });
    expect(categories(h.audits)).toEqual([
      'sale.return.attempted',
      'sale.return.confirmed',
      'sale.return.payout_ready',
    ]);
    expect(h.audits[1]?.payload).toMatchObject({ replayed: true });

    // Nothing is left to resolve, so a further pass sends nothing.
    await h.resolver.resolveOnce(ACTOR);
    expect(h.backend.returnCalls()).toHaveLength(2);
  });

  it('a 200 provenance replay (Idempotent-Replayed) also confirms', async () => {
    const returnId = await submitWithLostAnswer();
    h.backend.onReturn = (call, backend) => {
      const stored = backend.recorded.get(call.headers['Idempotency-Key'] ?? '');
      return jsonResponse(200, stored, { 'Idempotent-Replayed': 'true' });
    };
    await h.resolver.resolveOnce(ACTOR);
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });

  it('crash before send: a pending journal row is sent by the resolver', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    const externalId = 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000123';
    h.repo.insert({
      returnId: 'ret-pending',
      scope: SCOPE,
      saleId: 'sale-1',
      saleNumber: SALE_NUMBER,
      serverSaleRef: SALE_REF,
      externalId,
      operatorId: 'op-manager',
      operatorSessionId: 'sess-manager',
      currencyCode: 'EGP',
      quotedTotalMinor: 1500,
      requestBodyJson: JSON.stringify({
        sourceSystem: 'pos-pulse',
        externalId,
        lines: [{ lineRef: LINE_A, quantity: '1' }],
        refundTenders: [{ method: 'cash', amount: '15.00' }],
      }),
      lines: [{ lineRef: LINE_A, quantity: 1 }],
      now: '2026-10-04T09:59:00.000Z',
    });

    await h.resolver.resolveOnce(ACTOR);
    expect(h.backend.returnCalls()[0]?.headers['Idempotency-Key']).toBe(externalId);
    expect(h.repo.read('ret-pending')).toMatchObject({ state: 'confirmed', attemptCount: 1 });
  });

  it('a refusal on resend is final; a still-lost answer stays unknown', async () => {
    await submitWithLostAnswer();
    h.backend.onReturn = () => jsonResponse(503, errorBody('internal_error'));
    await expect(h.resolver.resolveOnce(ACTOR)).resolves.toEqual({
      confirmed: 0,
      refused: 0,
      unresolved: 1,
    });
    h.backend.onReturn = () => jsonResponse(409, errorBody('already_reversed'));
    await expect(h.resolver.resolveOnce(ACTOR)).resolves.toEqual({
      confirmed: 0,
      refused: 1,
      unresolved: 0,
    });
    expect(h.audits.at(-1)?.payload).toMatchObject({
      operation: 'resolve',
      reason: 'already_reversed',
    });
  });

  it('tick does nothing without an operator envelope, then resolves once one is present', async () => {
    await submitWithLostAnswer();
    h.state.token = null;
    await expect(h.resolver.tick(SCOPE)).resolves.toBeNull();
    expect(h.backend.returnCalls()).toHaveLength(1);
    h.state.token = 'envelope-2';
    await expect(h.resolver.tick(SCOPE)).resolves.toMatchObject({ confirmed: 1 });
  });

  it('passes are single-flight: a concurrent pass shares the running one', async () => {
    await submitWithLostAnswer();
    const [a, b] = await Promise.all([h.resolver.resolveOnce(ACTOR), h.resolver.tick(SCOPE)]);
    expect(a).toEqual({ confirmed: 1, refused: 0, unresolved: 0 });
    expect(b).toBeNull();
    const [c, d] = await Promise.all([
      h.resolver.resolveOnce(ACTOR),
      h.resolver.resolveOnce(ACTOR),
    ]);
    expect(c).toBe(d);
    expect(h.backend.returnCalls()).toHaveLength(2);
  });

  it('the on-demand returns.resolve is gated and reports the tally', async () => {
    await submitWithLostAnswer();
    h.state.role = 'cashier';
    await expect(h.service.resolve()).resolves.toEqual({ kind: 'refused', reason: 'role_denied' });
    h.state.role = 'admin';
    await expect(h.service.resolve()).resolves.toEqual({
      kind: 'ok',
      confirmed: 1,
      refused: 0,
      unresolved: 0,
    });
  });
});
