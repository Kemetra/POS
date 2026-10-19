/**
 * RT-196 S1 — why a return is unknown, recorded per attempt.
 *
 *   • every send that leaves the row `unknown` writes exactly one
 *     `sale.return.attempt_unknown` audit with its cause, in the same local
 *     transaction as `markUnknown` (the confirm / refuse pattern);
 *   • a send that confirms, refuses or is deferred writes none;
 *   • the payload carries ids and closed codes only: no body, no envelope;
 *   • if that audit cannot be written the row still becomes `unknown` (it
 *     keeps its backoff; it is never left `pending` to be re-sent every tick);
 *   • `returns.list` shows the attempt count, the last attempt and the last
 *     cause of an unresolved row (null once it is resolved).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import type { ReturnUnknownCause } from '../../../shared/returns/types.js';
import { nn } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  ENVELOPE,
  LINE_A,
  MANAGER_ACTOR,
  NOW,
  SALE_ID,
  SALE_NUMBER,
  categories,
  errorBody,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  saleReturnFor,
  secondsAfterNow,
  seedSyncedSale,
  type ReturnResponder,
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
const UNKNOWN = 'sale.return.attempt_unknown';

function harness(): ReturnsHarness {
  h = returnsHarness();
  seedSyncedSale(h.db);
  return h;
}

function unknownAudits(): AuditEvent[] {
  return h.audits.filter((e) => e.action_category === UNKNOWN);
}

/** Journal one return whose first send is lost (a refused connection). */
async function unknownReturn(): Promise<string> {
  h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`unknownReturn: ${res.kind}`);
  return res.ret.returnId;
}

describe('RT-196 S1 — the cause of each unknown attempt', () => {
  it.each<[string, ReturnResponder, ReturnUnknownCause]>([
    ['a timeout', () => Promise.reject(new DOMException('t', 'TimeoutError')), 'timeout'],
    ['a refused connection', () => Promise.reject(new TypeError('ECONNREFUSED')), 'network'],
    ['a 502', () => jsonResponse(502, errorBody('bad_gateway')), 'server_5xx'],
    ['a 429', () => jsonResponse(429, errorBody('rate_limited')), 'rate_limited'],
    ['a 201 with no SaleReturn', () => jsonResponse(201, { ok: true }), 'unreadable_body'],
    [
      'a confirmation that names another total (U-3)',
      (call) =>
        jsonResponse(201, {
          ...saleReturnFor(JSON.parse(call.body ?? '{}') as never),
          returnTotal: '14.0000',
        }),
      'confirmation_mismatch',
    ],
  ])('a first send lost to %s writes one attempt_unknown (%s)', async (_label, respond, cause) => {
    harness();
    h.backend.onReturn = respond;

    const res = await h.service.submit(ONE_A);

    expect(res).toMatchObject({ kind: 'unconfirmed', ret: { state: 'unknown' } });
    expect(categories(h.audits)).toEqual(['sale.return.attempted', UNKNOWN]);
    const [event] = unknownAudits();
    expect(event?.payload).toEqual({
      return_id: res.ret?.returnId,
      sale_id: SALE_ID,
      attempt_no: 1,
      cause,
      operation: 'submit',
    });
    expect(event?.acting_operator_id).toBe(MANAGER_ACTOR.operatorId);
  });

  it.each<[number, string, ReturnUnknownCause]>([
    [401, 'unauthorized', 'pre_replay_401'],
    [403, 'forbidden', 'pre_replay_403'],
    [404, 'not_found', 'pre_replay_404'],
  ])('a resend that gets %s (%s) writes %s (U-1 / U-2)', async (status, code, cause) => {
    harness();
    const returnId = await unknownReturn();
    h.backend.onReturn = () => jsonResponse(status, errorBody(code));

    await h.resolver.resolveOnce(MANAGER_ACTOR);

    expect(h.repo.read(returnId)?.state).toBe('unknown');
    expect(unknownAudits().map((e) => e.payload)).toEqual([
      expect.objectContaining({ attempt_no: 1, cause: 'network', operation: 'submit' }),
      expect.objectContaining({ attempt_no: 2, cause, operation: 'resolve' }),
    ]);
  });

  it('a local commit that fails after the answer is recorded as local_commit_failed', async () => {
    harness();
    h.state.failAudit = (e) => e.action_category === 'sale.return.confirmed';

    await h.service.submit(ONE_A);

    expect(h.warnings).toContain('returns:local_commit_failed');
    expect(unknownAudits().map((e) => e.payload['cause'])).toEqual(['local_commit_failed']);
  });

  it('a send that confirms, refuses or is deferred writes no attempt_unknown', async () => {
    harness();
    await h.service.submit(ONE_A);
    seedSyncedSale(h.db, { saleId: 'sale-2' });
    h.backend.onReturn = () => jsonResponse(409, errorBody('over_return'));
    await h.service.submit({ ...ONE_A, saleNumber: 'SN-sale-2' });
    seedSyncedSale(h.db, { saleId: 'sale-3' });
    h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
    await h.service.submit({ ...ONE_A, saleNumber: 'SN-sale-3' });
    h.state.locked = true;

    await h.resolver.resolveOnce(MANAGER_ACTOR);

    expect(unknownAudits()).toHaveLength(1);
  });

  it('a failed attempt_unknown audit still leaves the row unknown, with its backoff', async () => {
    harness();
    h.state.failAudit = (e) => e.action_category === UNKNOWN;
    h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));

    const res = await h.service.submit(ONE_A);

    expect(res).toMatchObject({ kind: 'unconfirmed', ret: { state: 'unknown' } });
    expect(h.repo.read(res.ret?.returnId ?? '')?.state).toBe('unknown');
    expect(h.warnings).toContain('returns:attempt_unknown_audit_failed');
    expect(unknownAudits()).toHaveLength(0);
    // Not `pending`: a background tick right after the send waits for the backoff.
    await expect(h.resolver.tick()).resolves.toMatchObject({ unresolved: 1 });
    expect(h.backend.returnCalls()).toHaveLength(1);
  });

  it('the payload carries no body, envelope or Idempotency-Key', async () => {
    harness();
    await unknownReturn();
    const [event] = unknownAudits();
    const text = JSON.stringify(event);
    const entry = nn(h.repo.read(String(event?.payload['return_id'])));
    expect(text).not.toContain(ENVELOPE);
    expect(text).not.toContain(entry.externalId);
    expect(text).not.toContain(entry.requestBodyJson);
  });
});

describe('RT-196 S1 — returns.list shows the attempt history summary', () => {
  it('an unknown row shows its attempt count, last attempt and last cause', async () => {
    harness();
    const returnId = await unknownReturn();
    h.state.now = secondsAfterNow(30);
    h.backend.onReturn = () => jsonResponse(503, errorBody('unavailable'));
    await h.resolver.resolveOnce(MANAGER_ACTOR);

    const list = await h.service.list();

    expect(list.kind).toBe('ok');
    const row = list.kind === 'ok' ? list.returns.find((r) => r.returnId === returnId) : undefined;
    expect(row).toMatchObject({
      state: 'unknown',
      attemptCount: 2,
      lastAttemptAt: secondsAfterNow(30),
      lastCause: 'server_5xx',
    });
  });

  it('a resolved row shows no cause; a never-sent row shows no attempt', async () => {
    harness();
    const returnId = await unknownReturn();
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    await h.resolver.resolveOnce(MANAGER_ACTOR);

    const list = await h.service.list();

    const row = list.kind === 'ok' ? list.returns.find((r) => r.returnId === returnId) : undefined;
    expect(row).toMatchObject({ state: 'confirmed', attemptCount: 2, lastCause: null });
  });

  it('a cause outside the closed set reads as null (fail closed)', async () => {
    harness();
    const returnId = await unknownReturn();
    const [event] = unknownAudits();
    h.auditSink.emit({
      ...nn(event),
      event_id: 'evt-forged',
      payload: { ...nn(event).payload, cause: 'made_up' },
    });

    const list = await h.service.list();

    const row = list.kind === 'ok' ? list.returns.find((r) => r.returnId === returnId) : undefined;
    expect(row?.lastCause).toBeNull();
  });

  it('§A4 D-1: a row crosses the bridge with exactly the closed key set (nothing secret added)', async () => {
    harness();
    await unknownReturn();

    const list = await h.service.list();

    const row = list.kind === 'ok' ? list.returns[0] : undefined;
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        // RT-15 S2/S4 fields
        'confirmedAt',
        'createdAt',
        'currencyCode',
        'lines',
        'payout',
        'quotedTotalMinor',
        'refusalReason',
        'returnId',
        'returnRef',
        'returnTotalMinor',
        'saleId',
        'saleNumber',
        'state',
        // RT-196 S1: the only three additions
        'attemptCount',
        'lastAttemptAt',
        'lastCause',
      ].sort(),
    );
    const text = JSON.stringify(row);
    for (const secret of [ENVELOPE, 'externalId', 'requestBodyJson', 'Idempotency']) {
      expect(text).not.toContain(secret);
    }
  });

  it('the submit answer of a lost send names its cause', async () => {
    harness();
    h.backend.onReturn = () => Promise.reject(new DOMException('t', 'TimeoutError'));
    const res = await h.service.submit(ONE_A);
    expect(res).toMatchObject({
      kind: 'unconfirmed',
      ret: { attemptCount: 1, lastAttemptAt: NOW, lastCause: 'timeout' },
    });
  });
});
