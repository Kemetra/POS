/**
 * RT-15 S4 — who may pay out, and what happens when the session changes
 * mid-payout (invariants A1–A5, U2, U3).
 *
 * The payout is admitted with the RT-197 immutable authorization snapshot and
 * re-checked at its commit point (after the drawer kick, before paid_out).
 * A lock, sign-out or operator switch while the drawer is answering leaves the
 * payout started but not recorded; the next eligible operator completes it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerKickResult } from '../../drawer/drawer-kick-transport.js';

import type { Role } from '../../../shared/operator/role.js';
import {
  ENVELOPE,
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
  h.close();
});

function paidOutCount(): number {
  return categories(h.audits).filter((c) => c === 'sale.return.paid_out').length;
}

describe('A1: manager or admin, flag on, a session', () => {
  it('refuses a cashier (audited) and never kicks', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.role = 'cashier';
    expect(await h.service.payout({ returnId, action: 'start' })).toEqual({
      kind: 'refused',
      reason: 'role_denied',
      ret: null,
    });
    expect(await h.service.reprintSlip({ returnId })).toEqual({
      kind: 'refused',
      reason: 'role_denied',
    });
    expect(h.audits.at(-1)).toMatchObject({
      action_category: 'sale.return.refused',
      acting_operator_id: 'op-cashier',
      payload: { operation: 'reprint', reason: 'role_denied' },
    });
    expect(h.drawer.kicks).toBe(0);
  });

  it.each<[string, (x: ReturnsHarness) => void, string]>([
    ['the flag is off', (x) => (x.state.enabled = false), 'feature_disabled'],
    ['nobody is signed in', (x) => (x.state.role = null), 'no_session'],
    ['the session is locked', (x) => (x.state.locked = true), 'session_changed'],
  ])('refuses when %s', async (_label, change, reason) => {
    const returnId = await confirmedReturn(h.service);
    change(h);
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({ reason });
    expect(h.drawer.kicks).toBe(0);
  });
});

describe('A2: the snapshot is rechecked after the kick, before paid_out', () => {
  it.each<[string, (x: ReturnsHarness) => void]>([
    ['locked', (x) => (x.state.locked = true)],
    ['signed out', (x) => (x.state.role = null)],
    ['switched to another operator', (x) => (x.state.role = 'admin')],
    ['given a new envelope', (x) => (x.state.token = `${ENVELOPE}-rotated`)],
  ])('a session %s while the drawer answers records no payout', async (_label, change) => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.onKick = () => {
      change(h);
    };
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({ kind: 'refused', ret: null });
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
    expect(paidOutCount()).toBe(0);
    expect(h.audits.at(-1)).toMatchObject({
      action_category: 'sale.return.refused',
      acting_operator_id: 'op-manager',
      payload: { return_id: returnId, operation: 'payout' },
    });
  });

  it('the next eligible operator completes the interrupted payout', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.onKick = () => {
      h.state.locked = true;
    };
    await h.service.payout({ returnId, action: 'start' });
    h.drawer.onKick = null;
    h.state.locked = false;
    h.state.role = 'admin';
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
      method: 'manual',
    });
  });
});

describe('A3: no data for a session that is no longer the admitted one', () => {
  it('a lock while the slip prints withholds the answer; the payout stands', async () => {
    const returnId = await confirmedReturn(h.service);
    h.printer.answer = () => {
      h.state.locked = true;
      return Promise.resolve({ ok: true, render_path: 'os_print' });
    };
    expect(await h.service.payout({ returnId, action: 'start' })).toEqual({
      kind: 'refused',
      reason: 'session_changed',
      ret: null,
    });
    expect(h.repo.read(returnId)?.state).toBe('paid_out');
  });

  it('a switch while a reprint prints withholds the answer', async () => {
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    h.printer.answer = () => {
      h.state.role = 'admin';
      return Promise.resolve({ ok: true, render_path: 'os_print' });
    };
    expect(await h.service.reprintSlip({ returnId })).toEqual({
      kind: 'refused',
      reason: 'session_changed',
    });
  });
});

describe('A4: the paying operator is recorded', () => {
  it.each<Role>(['admin', 'manager'])(
    '%s pays out a return recorded by the manager',
    async (role) => {
      const returnId = await confirmedReturn(h.service);
      h.state.role = role;
      await h.service.payout({ returnId, action: 'start' });
      const paid = h.audits.find((a) => a.action_category === 'sale.return.paid_out');
      expect(paid).toMatchObject({ acting_operator_id: `op-${role}`, session_id: `sess-${role}` });
      const row = h.db.exec(
        'SELECT started_operator_id, paid_operator_id, paid_operator_name FROM return_payouts',
      )[0]?.values[0];
      expect(row).toEqual([`op-${role}`, `op-${role}`, `Display ${role}`]);
      expect(h.printer.textOf(0)).toContain(`Paid by: Display ${role}`);
    },
  );
});

describe('A5: only a return of this terminal', () => {
  it('a return of another terminal is not found, and nothing is disclosed', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.terminalId = 'term-2';
    expect(await h.service.payout({ returnId, action: 'start' })).toEqual({
      kind: 'refused',
      reason: 'return_not_found',
      ret: null,
    });
    expect(await h.service.reprintSlip({ returnId })).toEqual({
      kind: 'refused',
      reason: 'return_not_found',
    });
    expect(h.drawer.kicks).toBe(0);
  });

  it('an unknown return id is not found', async () => {
    expect(await h.service.payout({ returnId: 'no-such-return', action: 'start' })).toMatchObject({
      reason: 'return_not_found',
    });
  });
});

describe('U2: atomic commits', () => {
  it('a failed payout_started audit leaves no claim and never kicks', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.failAudit = (e) => e.action_category === 'sale.return.payout_started';
    await expect(h.service.payout({ returnId, action: 'start' })).rejects.toThrow();
    expect(h.db.exec('SELECT COUNT(*) FROM return_payouts')[0]?.values[0]?.[0]).toBe(0);
    expect(h.drawer.kicks).toBe(0);
  });

  it('a failed paid_out audit rolls the payout back to started', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.failAudit = (e) => e.action_category === 'sale.return.paid_out';
    await expect(h.service.payout({ returnId, action: 'start' })).rejects.toThrow();
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
    expect(h.db.exec('SELECT paid_at FROM return_payouts')[0]?.values[0]?.[0]).toBeNull();
    h.state.failAudit = null;
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
    });
  });
});

describe('in-flight sharing is per admitted actor (Codex P2, #530)', () => {
  it('a caller in a new terminal scope never joins the old payout or sees its result', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const first = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    h.state.terminalId = 'term-2';
    const second = h.service.payout({ returnId, action: 'retry_drawer' });
    kick.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    expect(await second).toEqual({ kind: 'refused', reason: 'return_not_found', ret: null });
    await first;
    expect(h.drawer.kicks).toBe(1);
  });

  it('another operator waits for the running payout, then runs their own, with no concurrent kick', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const first = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    h.state.role = 'admin';
    const second = h.service.payout({ returnId, action: 'manual' });
    kick.resolve({ ok: true });
    // The manager's payout lost its session after the kick: nothing recorded.
    expect(await first).toMatchObject({ kind: 'refused', reason: 'session_changed', ret: null });
    // The admin's own manual payout then completes it, once.
    expect(await second).toMatchObject({ kind: 'paid_out', method: 'manual' });
    expect(h.drawer.kicks).toBe(1);
    expect(paidOutCount()).toBe(1);
  });

  it('a reprint by another operator never shares the running one', async () => {
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    const print = deferredFake<{ ok: true; render_path: 'os_print' }>();
    h.printer.answer = () => print.promise;
    const first = h.service.reprintSlip({ returnId });
    await vi.waitFor(() => {
      expect(h.printer.printed).toHaveLength(2);
    });
    h.state.terminalId = 'term-2';
    const second = h.service.reprintSlip({ returnId });
    print.resolve({ ok: true, render_path: 'os_print' });
    expect(await second).toEqual({ kind: 'refused', reason: 'return_not_found' });
    await first;
    expect(h.printer.printed).toHaveLength(2);
  });

  it('Z1: an operation queued behind another starts after stop and touches nothing', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const first = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    h.state.role = 'admin';
    const second = h.service.payout({ returnId, action: 'manual' });
    h.stop();
    const before = h.audits.length;
    kick.resolve({ ok: true });
    await first;
    expect(await second).toEqual({ kind: 'refused', reason: 'shutting_down', ret: null });
    // The running kick's opening is remembered (P1); the queued one wrote nothing.
    expect(categories(h.audits.slice(before))).toEqual(['sale.return.drawer_opened']);
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });
});
