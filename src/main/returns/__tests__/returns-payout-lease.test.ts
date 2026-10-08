/**
 * RT-15 S4 — Codex P1 on 35e0d03: a durable kick lease across app instances.
 *
 * The per-return queue is process-local; with no single-instance lock two app
 * processes can share the database. While one instance's kick is `sending`
 * and the lease (2 x the drawer timeout) has not passed, no instance may
 * complete that payout: refused `drawer_kick_in_progress`, atomically in the
 * guarded UPDATE (and by a 0040 trigger backstop). After the lease a
 * still-`sending` kick means its process died mid-kick: manual only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerKickResult } from '../../drawer/drawer-kick-transport.js';
import { RETURN_KICK_LEASE_MS } from '../returns-drawer.js';
import {
  categories,
  confirmedReturn,
  deferredFake,
  initReturnsSql,
  returnsHarness,
  secondsAfterNow,
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
  h.close();
});

const IN_PROGRESS = { kind: 'refused', reason: 'drawer_kick_in_progress' };

function paidOutCount(): number {
  return categories(h.audits).filter((c) => c === 'sale.return.paid_out').length;
}

describe('Codex P1: a kick in flight in another instance holds the payout', () => {
  it('a second instance cannot complete it manually while the first is kicking', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const first = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    const other = h.anotherInstance();
    expect(await other.service.payout({ returnId, action: 'manual' })).toMatchObject(IN_PROGRESS);
    expect(await other.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      reason: 'drawer_retry_unsafe',
    });
    expect(paidOutCount()).toBe(0);
    kick.resolve({ ok: true });
    expect(await first).toMatchObject({ kind: 'paid_out', method: 'drawer' });
    expect(h.drawer.kicks).toBe(1);
    expect(paidOutCount()).toBe(1);
  });

  it('after the lease, a kick still sending (its process died) completes manually only', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => new Promise<DrawerKickResult>(() => undefined);
    void h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    const after = h.restart();
    expect(await after.service.payout({ returnId, action: 'manual' })).toMatchObject(IN_PROGRESS);
    h.state.now = secondsAfterNow(RETURN_KICK_LEASE_MS / 1000);
    expect(await after.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      reason: 'drawer_retry_unsafe',
    });
    expect(await after.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
      method: 'manual',
    });
    expect(h.drawer.kicks).toBe(1);
  });
});
