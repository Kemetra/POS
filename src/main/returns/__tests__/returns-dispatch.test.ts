/**
 * RT-15 S2 — the dispatcher's guarantees (AC8, AC9).
 *
 *   • no double confirmation: re-sending a confirmed return (a late replay)
 *     changes nothing and writes no second confirmed / payout_ready audit;
 *   • concurrent sends of one return share one request (single-flight);
 *   • a confirmation that does not match the journaled return (another
 *     externalId, another sale, another total) is not trusted: the row stays
 *     `unknown` and nothing is payout-ready.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ContractSaleReturn } from './__contract__/sales-returns.contract.js';
import { nn } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createReturnsAudit } from '../returns-audit.js';
import { createReturnsClient } from '../returns-client.js';
import { createReturnsDispatcher } from '../returns-dispatch.js';
import type { ReturnsRepository } from '../returns-repository.js';
import {
  BASE_URL,
  ENVELOPE,
  LINE_A,
  NOW,
  SCOPE,
  SALE_NUMBER,
  categories,
  errorBody,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  saleReturnFor,
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

let eventSeq = 0;

/** A second dispatcher over the same journal (as a stale resolver would hold). */
function standaloneDispatcher(repo: ReturnsRepository = h.repo) {
  return createReturnsDispatcher({
    client: createReturnsClient({
      baseUrl: BASE_URL,
      fetch: h.backend.fetch,
      getOperatorToken: () => ENVELOPE,
    }),
    repo,
    audit: createReturnsAudit({
      sink: h.auditSink,
      now: () => NOW,
      newEventId: () => `evt-${String((eventSeq += 1))}`,
    }),
    now: () => NOW,
    logger: { warn: () => undefined },
    transaction: <T>(fn: () => T): T => h.handle.transaction(fn)(),
  });
}

describe('returns dispatcher', () => {
  it('no double confirmation: re-sending a confirmed return writes no second audit', async () => {
    harness();
    const res = await h.service.submit(ONE_A);
    const entry = h.repo.read(res.ret?.returnId ?? '');
    expect(entry?.state).toBe('confirmed');
    const dispatcher = standaloneDispatcher();

    const again = await dispatcher.send(nn(entry), 'resolve');

    expect(again).toMatchObject({
      kind: 'confirmed',
      replayed: false,
      entry: { state: 'confirmed' },
    });
    expect(h.backend.returnCalls()).toHaveLength(2);
    expect(categories(h.audits)).toEqual([
      'sale.return.attempted',
      'sale.return.confirmed',
      'sale.return.payout_ready',
    ]);
  });

  it('a refused return stays refused when sent again (final state, no new audit)', async () => {
    harness();
    h.backend.onReturn = () => jsonResponse(409, errorBody('over_return'));
    const res = await h.service.submit(ONE_A);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

    const again = await standaloneDispatcher().send(
      nn(h.repo.read(res.ret?.returnId ?? '')),
      'resolve',
    );

    expect(again).toMatchObject({ kind: 'refused', reason: 'over_return' });
    expect(categories(h.audits)).toEqual(['sale.return.attempted', 'sale.return.refused']);
  });

  it('a resolver pass during an in-flight submit shares its single request', async () => {
    harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.backend.onReturn = async (call, backend) => {
      await gate;
      return backend.recordIdempotently(call);
    };
    const submitting = h.service.submit(ONE_A);
    while (h.backend.returnCalls().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const resolving = h.resolver.resolveOnce({ scope: SCOPE });
    release();
    const [submitted, resolved] = await Promise.all([submitting, resolving]);
    expect(submitted.kind).toBe('confirmed');
    expect(resolved.confirmed).toBe(1);
    expect(h.backend.returnCalls()).toHaveLength(1);
    expect(categories(h.audits)).toEqual([
      'sale.return.attempted',
      'sale.return.confirmed',
      'sale.return.payout_ready',
    ]);
  });

  it.each<{ label: string; tamper: (r: ContractSaleReturn) => ContractSaleReturn }>([
    {
      label: 'another externalId',
      tamper: (r) => ({ ...r, externalId: 'pos-pulse-return:other' }),
    },
    {
      label: 'another sale',
      tamper: (r) => ({ ...r, saleRef: '0190f5a2-7b3c-7d4e-8f90-0000000000aa' }),
    },
    { label: 'another total', tamper: (r) => ({ ...r, returnTotal: '14.0000' }) },
    { label: 'an unpayable total', tamper: (r) => ({ ...r, returnTotal: '15.0050' }) },
  ])('does not trust a confirmation naming $label', async ({ tamper }) => {
    harness();
    h.backend.onReturn = (call) =>
      jsonResponse(201, tamper(saleReturnFor(JSON.parse(call.body ?? '{}') as never)));
    const res = await h.service.submit(ONE_A);
    expect(res).toMatchObject({ kind: 'unconfirmed', ret: { state: 'unknown' } });
    expect(categories(h.audits)).toEqual(['sale.return.attempted']);
    expect(h.warnings).toContain('returns:confirmation_mismatch');
  });
});

describe('returns dispatcher — atomic confirmation with its audits (Codex P2)', () => {
  const PAYOUT = 'sale.return.payout_ready';

  it.each<{ label: string; failing: string }>([
    { label: 'the confirmed audit', failing: 'sale.return.confirmed' },
    { label: 'the payout_ready audit', failing: PAYOUT },
  ])(
    'when $label fails: no confirmation, no partial audit, then the resolver confirms once',
    async ({ failing }) => {
      harness();
      h.state.failAudit = (e) => e.action_category === failing;

      const res = await h.service.submit(ONE_A);

      expect(res).toMatchObject({
        kind: 'unconfirmed',
        ret: { state: 'unknown', returnRef: null },
      });
      expect(categories(h.audits)).toEqual(['sale.return.attempted']);
      expect(h.warnings).toContain('returns:local_commit_failed');

      h.state.failAudit = null;
      await expect(h.resolver.resolveOnce({ scope: SCOPE })).resolves.toMatchObject({
        confirmed: 1,
      });
      await h.resolver.resolveOnce({ scope: SCOPE });

      expect(h.repo.read(res.ret?.returnId ?? '')?.state).toBe('confirmed');
      expect(h.backend.recorded.size).toBe(1);
      expect(categories(h.audits)).toEqual([
        'sale.return.attempted',
        'sale.return.confirmed',
        PAYOUT,
      ]);
    },
  );

  it('a failed refusal audit rolls back the refusal; the resend refuses once', async () => {
    harness();
    h.backend.onReturn = () => jsonResponse(409, errorBody('over_return'));
    h.state.failAudit = (e) => e.action_category === 'sale.return.refused';

    const res = await h.service.submit(ONE_A);

    expect(res).toMatchObject({ kind: 'unconfirmed', ret: { state: 'unknown' } });
    h.state.failAudit = null;
    await expect(h.resolver.resolveOnce({ scope: SCOPE })).resolves.toMatchObject({ refused: 1 });
    expect(categories(h.audits)).toEqual(['sale.return.attempted', 'sale.return.refused']);
  });

  it('a replay after confirmation writes no duplicate audits', async () => {
    harness();
    const res = await h.service.submit(ONE_A);
    const entry = nn(h.repo.read(res.ret?.returnId ?? ''));
    await standaloneDispatcher().send(entry, 'resolve');
    await standaloneDispatcher().send(entry, 'resolve');
    expect(categories(h.audits).filter((c) => c === PAYOUT)).toHaveLength(1);
    expect(h.audits).toHaveLength(3);
  });

  it('never rejects once the server answered, even if the journal cannot be written', async () => {
    harness();
    h.state.failAudit = (e) => e.action_category !== 'sale.return.attempted';
    const res = await h.service.submit(ONE_A);
    const entry = nn(h.repo.read(res.ret?.returnId ?? ''));
    const broken: ReturnsRepository = Object.assign(Object.create(h.repo) as ReturnsRepository, {
      markUnknown: () => {
        throw new Error('disk full');
      },
    });

    const outcome = await standaloneDispatcher(broken).send(entry, 'resolve');

    expect(outcome).toMatchObject({ kind: 'unconfirmed', entry: { state: 'unknown' } });
    expect(h.repo.read(entry.returnId)?.state).toBe('unknown');
  });

  it('journals a return and its attempted audit atomically (a failed audit sends nothing)', async () => {
    harness();
    h.state.failAudit = (e) => e.action_category === 'sale.return.attempted';
    await expect(h.service.submit(ONE_A)).rejects.toThrow(/audit insert failed/);
    expect(h.db.exec('SELECT COUNT(*) FROM return_journal')[0]?.values[0]?.[0]).toBe(0);
    expect(h.backend.returnCalls()).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('P1: any send of an already-attempted row treats a 404 as unknown, not refused', async () => {
    harness();
    h.backend.onReturn = () => Promise.reject(new TypeError('fetch failed'));
    const res = await h.service.submit(ONE_A);
    const entry = nn(h.repo.read(res.ret?.returnId ?? ''));
    expect(entry.attemptCount).toBe(1);
    h.backend.onReturn = () => jsonResponse(404, errorBody('not_found'));

    const outcome = await standaloneDispatcher().send(entry, 'submit');

    expect(outcome).toMatchObject({ kind: 'unconfirmed', entry: { state: 'unknown' } });
  });
});
