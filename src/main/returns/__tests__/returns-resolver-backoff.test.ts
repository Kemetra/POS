/**
 * RT-197 I2 — resolver liveness with per-row backoff.
 *
 * The background resolver used to re-send every `unknown` row on every 30 s
 * tick, forever. An `unknown` row now waits the sale-sync backoff policy
 * (1 s doubling per attempt, capped at 5 min) after its last attempt, per row:
 *   • the delays grow, but a row is still retried at least every
 *     cap + one tick (liveness: an unknown return is never abandoned);
 *   • a never-sent `pending` row is not delayed;
 *   • one row's long backoff never delays another row;
 *   • the operator's on-demand `returns.resolve` is not delayed.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  LINE_A,
  MANAGER_ACTOR,
  SALE_NUMBER,
  initReturnsSql,
  returnsHarness,
  saleBody,
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
const TICK_SECONDS = 30;
const SALE_REF_2 = '0190f5a2-7b3c-7d4e-8f90-0000000000b2';

function loseEveryAnswer(): void {
  h.backend.onReturn = () => Promise.reject(new TypeError('socket hang up'));
}

/** Submit at the current clock; the answer is lost, so the row is `unknown`. */
async function unknownReturn(saleNumber = SALE_NUMBER): Promise<string> {
  loseEveryAnswer();
  const res = await h.service.submit({ ...ONE_A, saleNumber });
  if (res.kind !== 'unconfirmed') throw new Error(`expected unconfirmed, got ${res.kind}`);
  return res.ret.returnId;
}

/** Background ticks every 30 s from `from` to `to` (seconds); the seconds at which a POST went out. */
async function tickBetween(from: number, to: number): Promise<number[]> {
  const sentAt: number[] = [];
  for (let s = from; s <= to; s += TICK_SECONDS) {
    h.state.now = secondsAfterNow(s);
    const before = h.backend.returnCalls().length;
    await h.resolver.tick();
    if (h.backend.returnCalls().length > before) sentAt.push(s);
  }
  return sentAt;
}

describe('I2: per-row backoff for unknown returns', () => {
  it('retries an unknown row on the sale-sync schedule (1 s doubling, 5 min cap)', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    await unknownReturn(); // attempt 1 at t = 0

    const sentAt = await tickBetween(TICK_SECONDS, 30 * 60);

    // Due after 1, 2, 4, 8, 16, 32, 64, 128, 256, then 300 s (cap) — on the
    // first 30 s tick at or after it.
    expect(sentAt).toEqual([30, 60, 90, 120, 150, 210, 300, 450, 720, 1020, 1320, 1620]);
  });

  it('liveness: a capped row is still retried, and confirms once the answer arrives', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    const returnId = await unknownReturn();
    await tickBetween(TICK_SECONDS, 1620); // capped by now (last attempt at 1620)
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

    // Due 300 s (the cap) after the attempt at 1620: never later than that.
    expect(await tickBetween(1650, 1920)).toEqual([1920]);
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });

  it('one row’s long backoff does not delay another row', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    seedSyncedSale(h.db, { saleId: 'sale-2', saleRef: SALE_REF_2 });
    const slow = await unknownReturn();
    await tickBetween(TICK_SECONDS, 210); // `slow` now waits 64 s after t = 210
    h.state.now = secondsAfterNow(220);
    h.backend.sale = saleBody({ saleRef: SALE_REF_2 });
    const fresh = await unknownReturn('SN-sale-2'); // attempt 1 at t = 220
    const sent: string[] = [];
    h.backend.onReturn = (call) => {
      sent.push((JSON.parse(call.body ?? '{}') as { externalId: string }).externalId);
      return Promise.reject(new TypeError('socket hang up'));
    };

    await tickBetween(240, 240);

    expect(sent).toEqual([h.repo.read(fresh)?.externalId]);
    expect(h.repo.read(slow)?.attemptCount).toBe(7);
  });

  it('a never-sent pending row is sent on the next tick', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.state.onAudit = (event) => {
      if (event.action_category === 'sale.return.attempted') h.state.role = 'cashier';
    };
    await h.service.submit(ONE_A); // journaled, then deferred: pending, never sent
    h.state.onAudit = null;
    h.state.role = 'manager';

    await expect(h.resolver.tick()).resolves.toMatchObject({ confirmed: 1 });
  });

  it('the on-demand resolve is not delayed', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    const returnId = await unknownReturn();
    h.state.now = secondsAfterNow(0.5); // inside the 1 s backoff
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

    await expect(h.resolver.tick()).resolves.toMatchObject({ confirmed: 0, unresolved: 1 });
    await expect(h.resolver.resolveOnce(MANAGER_ACTOR)).resolves.toMatchObject({ confirmed: 1 });
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });
});
