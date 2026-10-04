/**
 * RT-197 (A5 / I1) — the immutable authorization snapshot.
 *
 * Admission captures the actor AND the operator envelope as one immutable
 * value. Every send (readSale GET, recordReturn POST) carries that snapshot's
 * envelope; nothing on a send path reads the live session or token. The live
 * state is compared with the snapshot only at the commit points (before the
 * journal insert and before the POST), so a session switch that lands after
 * the last check can never put another session's envelope on the wire.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ENVELOPE,
  LINE_A,
  SALE_NUMBER,
  SALE_REF,
  initReturnsSql,
  returnsHarness,
  saleBody,
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
const OTHER_ENVELOPE = 'another-sessions-envelope';
/** The SQL of `recordAttempt` — the last local step between the pre-POST recheck and the POST. */
const RECORD_ATTEMPT = /attempt_count = attempt_count \+ 1/;
/** The SQL of the saleRef lookup — the last local step before the readSale GET. */
const SALE_REF_LOOKUP = /SELECT server_sale_ref FROM sale_sync_state/;

function harness(): ReturnsHarness {
  h = returnsHarness();
  seedSyncedSale(h.db);
  return h;
}

/** Run `change` (once) right after the local statement matching `sql` is prepared. */
function changeDuring(sql: RegExp, change: () => void): void {
  const prepare = h.handle.prepare.bind(h.handle);
  let done = false;
  vi.spyOn(h.handle, 'prepare').mockImplementation((text: string) => {
    const stmt = prepare(text);
    if (!done && sql.test(text)) {
      done = true;
      change();
    }
    return stmt;
  });
}

function switchToAnotherSession(): void {
  h.state.role = 'admin';
  h.state.token = OTHER_ENVELOPE;
}

/** The Authorization header of every request the fake backend saw. */
function authorizations(): (string | undefined)[] {
  return h.backend.calls.map((c) => c.headers['Authorization']);
}

describe('A5: the envelope on the wire is the admitted snapshot’s own', () => {
  it('a switch between the pre-POST recheck and the POST still sends the snapshot envelope', async () => {
    harness();
    changeDuring(RECORD_ATTEMPT, switchToAnotherSession);

    await h.service.submit(ONE_A);

    expect(h.backend.returnCalls()).toHaveLength(1);
    expect(authorizations()).toEqual([`Bearer ${ENVELOPE}`, `Bearer ${ENVELOPE}`]);
  });

  it('a switch between admission and the readSale GET still sends the snapshot envelope', async () => {
    harness();
    changeDuring(SALE_REF_LOOKUP, switchToAnotherSession);

    const res = await h.service.lookup({ saleNumber: SALE_NUMBER });

    expect(authorizations()).toEqual([`Bearer ${ENVELOPE}`]);
    // The read is then refused to the new session (the post-read recheck).
    expect(res).toEqual({ kind: 'refused', reason: 'session_changed' });
  });

  it('the resolver pass sends with its start-of-pass snapshot; a rotated envelope stops the pass', async () => {
    harness();
    seedSyncedSale(h.db, { saleId: 'sale-2', saleRef: SALE_REF_2 });
    h.backend.onReturn = () => Promise.reject(new TypeError('socket hang up'));
    await h.service.submit(ONE_A);
    h.backend.sale = saleBody({ saleRef: SALE_REF_2 });
    await h.service.submit({ ...ONE_A, saleNumber: 'SN-sale-2' });
    h.backend.calls.length = 0;
    h.backend.onReturn = (call, backend) => {
      h.state.token = OTHER_ENVELOPE; // same session, the envelope is replaced mid-pass
      return backend.recordIdempotently(call);
    };

    await expect(h.resolver.tick()).resolves.toEqual({ confirmed: 1, refused: 0, unresolved: 1 });

    expect(authorizations()).toEqual([`Bearer ${ENVELOPE}`]);
  });
});

const SALE_REF_2 = '0190f5a2-7b3c-7d4e-8f90-0000000000b2';

describe('A5: no send path reads the operator token', () => {
  it('every token read during submit + resolve happens outside the returns client', async () => {
    harness();
    const readers: string[] = [];
    let token: string | null = ENVELOPE;
    Object.defineProperty(h.state, 'token', {
      get: () => {
        readers.push(new Error('token read').stack ?? '');
        return token;
      },
      set: (value: string | null) => {
        token = value;
      },
    });
    h.backend.onReturn = (call, backend) => {
      backend.recordIdempotently(call);
      return Promise.reject(new TypeError('socket hang up'));
    };

    await h.service.submit(ONE_A);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    await h.resolver.tick();

    expect(h.backend.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    expect(readers.length).toBeGreaterThan(0);
    for (const stack of readers) expect(stack).not.toMatch(/returns-client\.ts/);
    expect(h.backend.calls.every((c) => c.url.includes(SALE_REF))).toBe(true);
  });
});
