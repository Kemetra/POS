/**
 * RT-15 S4 — P1 (independent review of 5f31473): at most one drawer kick per
 * payout, unless the previous kick provably never reached the hardware.
 *
 * Every kick is marked `sending` durably BEFORE the transport is called, and
 * its outcome (opened / failed_before_send / unknown) is persisted with its
 * audit BEFORE any recheck or stop handling can return. `retry_drawer` is
 * allowed only after `failed_before_send`; after `opened` or `unknown` (a
 * timeout, a fault, a crash mid-kick) the only completion is the manual,
 * attested payout.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerKickResult } from '../../drawer/drawer-kick-transport.js';
import { RETURN_DRAWER_TIMEOUT_MS } from '../returns-drawer.js';
import {
  categories,
  confirmedReturn,
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

beforeEach(() => {
  h = returnsHarness();
  seedSyncedSale(h.db);
});

afterEach(() => {
  vi.useRealTimers();
  h.close();
});

function kickRecord(returnId: string): unknown[] | undefined {
  const sql = 'SELECT kick_outcome, kick_count FROM return_payouts WHERE return_id = ?';
  return h.db.exec(sql, [returnId])[0]?.values[0];
}

const UNSAFE_RETRY = { kind: 'refused', reason: 'drawer_retry_unsafe' };

describe('P1: no second kick after the till knows the drawer opened', () => {
  it.each<[string, (x: ReturnsHarness) => void, (x: ReturnsHarness) => void]>([
    ['a lock', (x) => (x.state.locked = true), (x) => (x.state.locked = false)],
    ['an operator switch', (x) => (x.state.role = 'admin'), () => undefined],
  ])(
    '%s between the opened kick and the commit leaves only the manual path',
    async (_l, cut, back) => {
      const returnId = await confirmedReturn(h.service);
      h.drawer.onKick = () => {
        cut(h);
      };
      expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
        kind: 'refused',
      });
      h.drawer.onKick = null;
      back(h);
      expect(kickRecord(returnId)).toEqual(['opened', 1]);
      expect(categories(h.audits)).toContain('sale.return.drawer_opened');
      expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject(
        UNSAFE_RETRY,
      );
      expect(h.drawer.kicks).toBe(1);
      expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
        kind: 'paid_out',
        method: 'manual',
      });
      expect(h.drawer.kicks).toBe(1);
    },
  );

  it('a stop during an opened kick still records and audits the opening; no retry after restart', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const pending = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    h.stop();
    kick.resolve({ ok: true });
    expect(await pending).toMatchObject({ kind: 'refused', reason: 'shutting_down' });
    expect(kickRecord(returnId)).toEqual(['opened', 1]);
    expect(h.audits.at(-1)).toMatchObject({ action_category: 'sale.return.drawer_opened' });
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
    const after = h.restart();
    expect(await after.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject(
      UNSAFE_RETRY,
    );
    expect(h.drawer.kicks).toBe(1);
  });

  it('a crash mid-kick (never answered) leaves the kick sending: unknown, no retry', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => new Promise<DrawerKickResult>(() => undefined);
    void h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    expect(kickRecord(returnId)).toEqual(['sending', 1]);
    const after = h.restart();
    expect(await after.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject(
      UNSAFE_RETRY,
    );
    expect(h.drawer.kicks).toBe(1);
  });
});

describe('P1 + reviewer P2-1: only a kick that provably never left may be retried', () => {
  it('no drawer configured is failed_before_send: a retry kicks again', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    await h.service.payout({ returnId, action: 'start' });
    expect(kickRecord(returnId)).toEqual(['failed_before_send', 1]);
    h.drawer.answer = () => Promise.resolve({ ok: true });
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      kind: 'paid_out',
      method: 'drawer',
    });
    expect(kickRecord(returnId)).toEqual(['opened', 2]);
  });

  it.each(['printer_dk_failure', 'os_error'] as const)(
    'a %s may have reached the drawer: unknown, no retry',
    async (failure_reason) => {
      const returnId = await confirmedReturn(h.service);
      h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason });
      expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
        kind: 'drawer_failed',
        reason: failure_reason,
      });
      expect(kickRecord(returnId)).toEqual(['unknown', 1]);
      expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject(
        UNSAFE_RETRY,
      );
      expect(h.drawer.kicks).toBe(1);
    },
  );

  it('a timeout is unknown (the late kick may still open the drawer): no retry', async () => {
    const returnId = await confirmedReturn(h.service);
    vi.useFakeTimers();
    h.drawer.answer = () => new Promise<DrawerKickResult>(() => undefined);
    const pending = h.service.payout({ returnId, action: 'start' });
    await vi.advanceTimersByTimeAsync(RETURN_DRAWER_TIMEOUT_MS);
    expect(await pending).toMatchObject({ kind: 'drawer_failed', reason: 'timeout' });
    expect(kickRecord(returnId)).toEqual(['unknown', 1]);
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject(
      UNSAFE_RETRY,
    );
    expect(h.drawer.kicks).toBe(1);
  });

  it('each drawer audit says what is known about the kick', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    await h.service.payout({ returnId, action: 'start' });
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'os_error' });
    await h.service.payout({ returnId, action: 'retry_drawer' });
    const drawer = h.audits.filter((a) => a.action_category === 'sale.return.drawer_failed');
    expect(drawer.map((a) => a.payload['kick_outcome'])).toEqual(['failed_before_send', 'unknown']);
  });
});
