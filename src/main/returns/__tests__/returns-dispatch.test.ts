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

/** A second dispatcher over the same journal (as a stale resolver would hold). */
function standaloneDispatcher() {
  return createReturnsDispatcher({
    client: createReturnsClient({
      baseUrl: BASE_URL,
      fetch: h.backend.fetch,
      getOperatorToken: () => ENVELOPE,
    }),
    repo: h.repo,
    audit: createReturnsAudit({
      sink: { emit: (e) => h.audits.push(e) },
      now: () => NOW,
      newEventId: () => 'evt',
    }),
    now: () => NOW,
    logger: { warn: () => undefined },
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
