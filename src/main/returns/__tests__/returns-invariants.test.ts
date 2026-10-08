/**
 * RT-197 — enforced-but-untested invariants of the return domain.
 *
 *   • D6: two concurrent submits for the same sale journal exactly one return;
 *     the other is refused `unresolved_return_exists` (and sends nothing).
 *   • E5: the attempt is committed before the POST — if `recordAttempt`
 *     throws, no POST is sent and the row stays pending and unsent.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  LINE_A,
  MANAGER_ACTOR,
  SALE_NUMBER,
  SCOPE,
  categories,
  initReturnsSql,
  returnsHarness,
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
const RECORD_ATTEMPT = /attempt_count = attempt_count \+ 1/;

function journalCount(): number {
  return Number(h.db.exec('SELECT COUNT(*) FROM return_journal')[0]?.values[0]?.[0] ?? 0);
}

/** Hold every POST until `release()`. */
function holdPosts(): { release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.backend.onReturn = async (call, backend) => {
    await gate;
    return backend.recordIdempotently(call);
  };
  return { release };
}

describe('D6: concurrent submits for one sale', () => {
  it('journal exactly one return; the other is refused unresolved_return_exists', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    const posts = holdPosts();

    const first = h.service.submit(ONE_A);
    const second = h.service.submit(ONE_A);
    while (h.backend.returnCalls().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    posts.release();
    const results = await Promise.all([first, second]);

    expect(results.map((r) => r.kind).sort()).toEqual(['confirmed', 'refused']);
    expect(results.find((r) => r.kind === 'refused')).toEqual({
      kind: 'refused',
      reason: 'unresolved_return_exists',
      ret: null,
    });
    expect(journalCount()).toBe(1);
    expect(h.backend.returnCalls()).toHaveLength(1);
    expect(h.backend.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(categories(h.audits)).toEqual([
      'sale.return.attempted',
      'sale.return.refused',
      'sale.return.confirmed',
      'sale.return.payout_ready',
    ]);
  });
});

describe('E5: a failed recordAttempt sends nothing', () => {
  function failRecordAttempt(): void {
    const prepare = h.handle.prepare.bind(h.handle);
    vi.spyOn(h.handle, 'prepare').mockImplementation((text: string) => {
      if (RECORD_ATTEMPT.test(text)) throw new Error('disk I/O error');
      return prepare(text);
    });
  }

  it('submit: no POST, the error surfaces, the row stays pending and unsent', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    failRecordAttempt();

    await expect(h.service.submit(ONE_A)).rejects.toThrow(/disk I\/O error/);

    expect(h.backend.returnCalls()).toHaveLength(0);
    expect(h.repo.listUnresolved(SCOPE)).toMatchObject([{ state: 'pending', attemptCount: 0 }]);
  });

  it('resolver: no POST for the row; it is sent once recordAttempt works again', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.backend.onReturn = () => Promise.reject(new TypeError('socket hang up'));
    await h.service.submit(ONE_A);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    failRecordAttempt();

    await expect(h.resolver.resolveOnce(MANAGER_ACTOR)).rejects.toThrow(/disk I\/O error/);
    expect(h.backend.returnCalls()).toHaveLength(1);

    vi.restoreAllMocks();
    await expect(h.resolver.resolveOnce(MANAGER_ACTOR)).resolves.toMatchObject({ confirmed: 1 });
    expect(h.backend.returnCalls()).toHaveLength(2);
  });
});
