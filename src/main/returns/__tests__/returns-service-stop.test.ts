/**
 * RT-198 — the return service observes the shutdown stop latch.
 *
 * After stop, every `returns.*` call answers `shutting_down` (not audited:
 * shutdown is not an operator refusal) before it touches the database. A
 * call whose await is in flight when the domain stops checks the latch first
 * when it resumes, so it writes nothing: no journal row, no line, no audit —
 * not even the refusal its session change would otherwise have earned.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  LINE_A,
  SALE_NUMBER,
  deferredFake,
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
const SHUTTING_DOWN = { kind: 'refused', reason: 'shutting_down' } as const;

function setup(): ReturnsHarness {
  h = returnsHarness();
  seedSyncedSale(h.db);
  return h;
}

/** Rows inserted, updated or deleted on the connection so far, in any table. */
function writes(): number {
  return Number(h.db.exec('SELECT total_changes()')[0]?.values[0]?.[0] ?? 0);
}

describe('RT-198: after stop', () => {
  it('every call is shutting_down before any DB access (the DB is already closed)', async () => {
    setup();
    const { service } = h;
    // The app quits: the domain is latched stopped and its database closes.
    h.restart();
    const before = writes();
    await expect(service.lookup({ saleNumber: SALE_NUMBER })).resolves.toEqual(SHUTTING_DOWN);
    await expect(service.quote(ONE_A)).resolves.toEqual(SHUTTING_DOWN);
    await expect(service.submit(ONE_A)).resolves.toEqual({ ...SHUTTING_DOWN, ret: null });
    await expect(service.resolve()).resolves.toEqual(SHUTTING_DOWN);
    await expect(service.list()).resolves.toEqual(SHUTTING_DOWN);
    expect([h.backend.calls.length, writes(), h.audits.length]).toEqual([0, before, 0]);
  });
});

describe('RT-198: a call in flight at stop writes nothing when it settles', () => {
  it.each([
    { label: 'submit (would journal it)', call: () => h.service.submit(ONE_A), change: null },
    {
      label: 'submit after a sign-out (would audit no_session)',
      call: () => h.service.submit(ONE_A),
      change: (): void => {
        h.state.role = null;
      },
    },
    {
      label: 'lookup after a switch to a cashier (would audit role_denied)',
      call: () => h.service.lookup({ saleNumber: SALE_NUMBER }),
      change: (): void => {
        h.state.role = 'cashier';
      },
    },
    {
      label: 'quote after a lock (would audit session_changed)',
      call: () => h.service.quote(ONE_A),
      change: (): void => {
        h.state.locked = true;
      },
    },
  ])('$label', async ({ call, change }) => {
    setup();
    const read = deferredFake<undefined>();
    h.backend.readLatency = () => read.promise;
    const pending = call();
    await vi.waitFor(() => {
      expect(h.backend.calls).toHaveLength(1);
    });
    change?.();
    h.stop();
    const before = writes();
    read.resolve(undefined);
    expect(await pending).toMatchObject(SHUTTING_DOWN);
    expect([writes() - before, h.audits.length, h.backend.calls.length]).toEqual([0, 0, 1]);
  });

  it('resolve: a pass in flight at stop answers shutting_down, with no refusal audit', async () => {
    setup();
    h.backend.onReturn = () => {
      throw new TypeError('socket hang up');
    };
    await h.service.submit(ONE_A); // journaled, its answer lost: unknown
    const post = deferredFake<Response>();
    h.backend.onReturn = () => post.promise;
    const pending = h.service.resolve();
    await vi.waitFor(() => {
      expect(h.backend.returnCalls()).toHaveLength(2);
    });
    h.state.role = 'cashier';
    h.stop();
    const before = [writes(), h.audits.length];
    post.resolve(new Response(null, { status: 503 }));
    expect(await pending).toEqual(SHUTTING_DOWN);
    expect([writes(), h.audits.length]).toEqual(before);
  });
});
