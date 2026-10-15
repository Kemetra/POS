/**
 * RT-531 — the cash drawer is optional: a refund on a terminal with no drawer.
 *
 * A kick answered `no_drawer_configured` means "this terminal has no drawer"
 * (Q3, Option A). The payout then completes from «صرف» alone: no manual
 * attestation step, recorded with the explicit method `no_drawer`, with the kick
 * outcome still audited. A configured drawer that fails (`printer_dk_failure`,
 * `os_error`, `timeout`) is unchanged: it warns and keeps the attestation, and
 * the double-pay guards (`drawer_retry_unsafe`) hold.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerKickResult } from '../../drawer/drawer-kick-transport.js';
import { RETURN_DRAWER_TIMEOUT_MS } from '../returns-drawer.js';
import {
  categories,
  confirmedReturn,
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

const NO_DRAWER = (): Promise<DrawerKickResult> =>
  Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });

function payoutRow(returnId: string): Record<string, unknown> | undefined {
  const res = h.db.exec('SELECT * FROM return_payouts WHERE return_id = ?', [returnId])[0];
  if (res === undefined) return undefined;
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

function payoutCategories(): string[] {
  return categories(h.audits).filter(
    (c) =>
      !['sale.return.attempted', 'sale.return.confirmed', 'sale.return.payout_ready'].includes(c),
  );
}

describe('RT-531 refund on a terminal with no drawer', () => {
  it('pays out from «صرف» alone: no attestation, method no_drawer, slip printed', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = NO_DRAWER;
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({
      kind: 'paid_out',
      method: 'no_drawer',
      slip: 'printed',
      ret: { state: 'paid_out', payout: { method: 'no_drawer' } },
    });
    expect(h.repo.read(returnId)?.state).toBe('paid_out');
    expect(h.drawer.kicks).toBe(1);
    expect(h.printer.printed).toHaveLength(1);
  });

  it('records an explicit value: the payout row says no_drawer, and the kick never left', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = NO_DRAWER;
    await h.service.payout({ returnId, action: 'start' });
    expect(payoutRow(returnId)).toMatchObject({
      method: 'no_drawer',
      kick_outcome: 'failed_before_send',
      kick_count: 1,
      paid_operator_id: 'op-manager',
    });
    expect(payoutRow(returnId)?.['paid_at']).not.toBeNull();
  });

  it('audits the kick outcome and the method: started, drawer_failed, paid_out(no_drawer), slip', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = NO_DRAWER;
    await h.service.payout({ returnId, action: 'start' });
    expect(payoutCategories()).toEqual([
      'sale.return.payout_started',
      'sale.return.drawer_failed',
      'sale.return.paid_out',
      'sale.return.slip_printed',
    ]);
    const drawer = h.audits.find((a) => a.action_category === 'sale.return.drawer_failed');
    expect(drawer?.payload).toMatchObject({
      failure_reason: 'no_drawer_configured',
      kick_outcome: 'failed_before_send',
    });
    const paidOut = h.audits.find((a) => a.action_category === 'sale.return.paid_out');
    expect(paidOut?.payload).toMatchObject({ method: 'no_drawer', payout_minor: 1500 });
  });

  it('a payout whose commit was lost after the kick is completed by retry_drawer as no_drawer', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = NO_DRAWER;
    // The till locks between the kick's answer and the commit: nothing is paid.
    h.drawer.onKick = () => {
      h.state.locked = true;
    };
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'refused',
    });
    h.drawer.onKick = null;
    h.state.locked = false;
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
    expect(payoutRow(returnId)).toMatchObject({ kick_outcome: 'failed_before_send' });
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      kind: 'paid_out',
      method: 'no_drawer',
    });
    expect(h.drawer.kicks).toBe(2);
  });

  it('pays out exactly once: a second start is already_paid_out and never kicks', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = NO_DRAWER;
    await h.service.payout({ returnId, action: 'start' });
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'refused',
      reason: 'already_paid_out',
    });
    expect(h.drawer.kicks).toBe(1);
    expect(payoutCategories().filter((c) => c === 'sale.return.paid_out')).toHaveLength(1);
  });
});

describe('RT-531 a configured drawer is unchanged', () => {
  it('an opened drawer still pays out as drawer', async () => {
    const returnId = await confirmedReturn(h.service);
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'paid_out',
      method: 'drawer',
    });
    expect(payoutRow(returnId)).toMatchObject({ method: 'drawer', kick_outcome: 'opened' });
  });

  it.each(['printer_dk_failure', 'os_error'] as const)(
    'a %s keeps the warning and the attestation: nothing paid, no retry, manual completes it',
    async (failure_reason) => {
      const returnId = await confirmedReturn(h.service);
      h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason });
      expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
        kind: 'drawer_failed',
        reason: failure_reason,
      });
      expect(h.repo.read(returnId)?.state).toBe('confirmed');
      expect(payoutRow(returnId)).toMatchObject({ kick_outcome: 'unknown', method: null });
      expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
        kind: 'refused',
        reason: 'drawer_retry_unsafe',
      });
      expect(h.drawer.kicks).toBe(1);
      expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
        kind: 'paid_out',
        method: 'manual',
      });
      expect(payoutRow(returnId)).toMatchObject({ method: 'manual' });
    },
  );

  it('a timeout keeps the warning and the attestation (the late kick may still open it)', async () => {
    const returnId = await confirmedReturn(h.service);
    vi.useFakeTimers();
    h.drawer.answer = () => new Promise<DrawerKickResult>(() => undefined);
    const pending = h.service.payout({ returnId, action: 'start' });
    await vi.advanceTimersByTimeAsync(RETURN_DRAWER_TIMEOUT_MS);
    expect(await pending).toMatchObject({ kind: 'drawer_failed', reason: 'timeout' });
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      kind: 'refused',
      reason: 'drawer_retry_unsafe',
    });
    expect(await h.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
      method: 'manual',
    });
  });

  it('no_drawer is never offered after a kick that may have opened the drawer', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'os_error' });
    await h.service.payout({ returnId, action: 'start' });
    // Even if the answer later reads "no drawer", the payout is not retryable.
    h.drawer.answer = NO_DRAWER;
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      kind: 'refused',
      reason: 'drawer_retry_unsafe',
    });
    expect(h.drawer.kicks).toBe(1);
  });
});
