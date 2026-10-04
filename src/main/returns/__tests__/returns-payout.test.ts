/**
 * RT-15 S4 — the cash payout of a confirmed return (AC9, AC12).
 *
 * Order: claim (durable + audited) → drawer kick → paid_out commit (with its
 * audit) → slip. Invariants X1–X5 (exactly once), C1–C4 (crash ordering),
 * M1–M2 (money), D1–D4 (drawer), S3–S4 (slip) and Z1–Z3 (shutdown), over the
 * real composed domain on sql.js with a fake drawer and printer.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerKickResult } from '../../drawer/drawer-kick-transport.js';
import type { ReturnState } from '../../../shared/returns/types.js';
import { RETURN_DRAWER_TIMEOUT_MS } from '../returns-drawer.js';
import {
  LINE_A,
  NOW,
  SALE_REF,
  SCOPE,
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

const PAYOUT_TRAIL = [
  'sale.return.payout_started',
  'sale.return.drawer_opened',
  'sale.return.paid_out',
  'sale.return.slip_printed',
];

/** The audit categories written after the return was confirmed. */
function payoutCategories(): string[] {
  return categories(h.audits).filter(
    (c) =>
      !['sale.return.attempted', 'sale.return.confirmed', 'sale.return.payout_ready'].includes(c),
  );
}

function payoutRow(returnId: string): Record<string, unknown> | undefined {
  const res = h.db.exec('SELECT * FROM return_payouts WHERE return_id = ?', [returnId])[0];
  if (res === undefined) return undefined;
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

const STATE_NO = { pending: 1, unknown: 2, refused: 3 } as const;

/** A journaled return of this terminal in a not-yet-payable state. */
function journaledIn(state: Exclude<ReturnState, 'confirmed' | 'paid_out'>): string {
  h.repo.insert({
    returnId: `r-${state}`,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    serverSaleRef: SALE_REF,
    externalId: `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-00000000000${String(STATE_NO[state])}`,
    operatorId: 'op-manager',
    operatorSessionId: 'sess-manager',
    currencyCode: 'EGP',
    quotedTotalMinor: 1500,
    requestBodyJson: '{}',
    lines: [{ lineRef: LINE_A, quantity: 1 }],
    now: 't0',
  });
  const stamp = { returnId: `r-${state}`, now: 't1' };
  if (state === 'unknown') h.repo.markUnknown(stamp);
  if (state === 'refused') h.repo.markRefused({ ...stamp, reason: 'over_return' });
  return `r-${state}`;
}

describe('X: exactly once', () => {
  it.each(['pending', 'unknown', 'refused'] as const)(
    'X1: a %s return is not payable — no claim, no kick, no slip',
    async (state) => {
      const returnId = journaledIn(state);
      const res = await h.service.payout({ returnId, action: 'start' });
      expect(res).toMatchObject({ kind: 'refused', reason: 'not_payable', ret: { state } });
      expect(payoutRow(returnId)).toBeUndefined();
      expect([h.drawer.kicks, h.printer.printed.length]).toEqual([0, 0]);
      expect(h.audits.at(-1)).toMatchObject({
        action_category: 'sale.return.refused',
        payload: { return_id: returnId, operation: 'payout', reason: 'not_payable' },
      });
    },
  );

  it('pays out a confirmed return once: claim, drawer, paid_out, slip', async () => {
    const returnId = await confirmedReturn(h.service);
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({
      kind: 'paid_out',
      method: 'drawer',
      slip: 'printed',
      ret: {
        returnId,
        state: 'paid_out',
        payout: { method: 'drawer', paidAt: NOW, startedAt: NOW },
      },
    });
    expect(payoutCategories()).toEqual(PAYOUT_TRAIL);
    expect([h.drawer.kicks, h.printer.printed.length]).toEqual([1, 1]);
  });

  it.each(['start', 'retry_drawer', 'manual'] as const)(
    'X2: %s on a paid-out return is refused already_paid_out and never kicks',
    async (action) => {
      const returnId = await confirmedReturn(h.service);
      await h.service.payout({ returnId, action: 'start' });
      const res = await h.service.payout({ returnId, action });
      expect(res).toMatchObject({
        kind: 'refused',
        reason: 'already_paid_out',
        ret: { state: 'paid_out' },
      });
      expect(h.drawer.kicks).toBe(1);
      expect(categories(h.audits).filter((c) => c === 'sale.return.paid_out')).toHaveLength(1);
    },
  );

  it('X3: a double click (concurrent calls) is one claim, one kick, one paid_out', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const first = h.service.payout({ returnId, action: 'start' });
    const second = h.service.payout({ returnId, action: 'start' });
    const third = h.service.payout({ returnId, action: 'manual' });
    kick.resolve({ ok: true });
    const answers = await Promise.all([first, second, third]);
    expect(answers.map((a) => a.kind)).toEqual(['paid_out', 'paid_out', 'paid_out']);
    expect(h.drawer.kicks).toBe(1);
    expect(payoutCategories()).toEqual(PAYOUT_TRAIL);
  });

  it('X4: start on a payout that was already started never kicks again', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    await h.service.payout({ returnId, action: 'start' });
    h.drawer.answer = () => Promise.resolve({ ok: true });
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({
      kind: 'refused',
      reason: 'payout_started',
      ret: {
        state: 'confirmed',
        payout: { startedAt: NOW, paidAt: null, method: null },
      },
    });
    expect(h.drawer.kicks).toBe(1);
  });

  it.each(['retry_drawer', 'manual'] as const)('X4: %s needs a started payout', async (action) => {
    const returnId = await confirmedReturn(h.service);
    const res = await h.service.payout({ returnId, action });
    expect(res).toMatchObject({ kind: 'refused', reason: 'payout_not_started' });
    expect(h.drawer.kicks).toBe(0);
  });

  it('X5: after a crash mid-kick the restarted till only completes, at most once', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => new Promise<DrawerKickResult>(() => undefined);
    void h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    const after = h.restart();
    h.drawer.answer = () => Promise.resolve({ ok: true });
    expect(await after.service.payout({ returnId, action: 'start' })).toMatchObject({
      reason: 'payout_started',
    });
    // P1: the kick may have opened the drawer: never kicked again.
    expect(await after.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      reason: 'drawer_retry_unsafe',
    });
    expect(await after.service.payout({ returnId, action: 'manual' })).toMatchObject({
      kind: 'paid_out',
      method: 'manual',
    });
    expect(await after.service.payout({ returnId, action: 'manual' })).toMatchObject({
      reason: 'already_paid_out',
    });
    expect(h.drawer.kicks).toBe(1);
    expect(categories(h.audits).filter((c) => c === 'sale.return.paid_out')).toHaveLength(1);
  });
});

describe('C: crash ordering', () => {
  it('C1: the claim and its audit are committed before the drawer kicks', async () => {
    const returnId = await confirmedReturn(h.service);
    let atKick: [unknown, string[]] = [undefined, []];
    h.drawer.onKick = () => {
      atKick = [payoutRow(returnId)?.['started_at'], categories(h.audits)];
    };
    await h.service.payout({ returnId, action: 'start' });
    expect(atKick[0]).toBe(NOW);
    expect(atKick[1].at(-1)).toBe('sale.return.payout_started');
  });

  it('C2: a failed kick records no payout; a manual payout then completes it without a kick', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    const failed = await h.service.payout({ returnId, action: 'start' });
    expect(failed).toMatchObject({
      kind: 'drawer_failed',
      reason: 'no_drawer_configured',
      ret: { state: 'confirmed', payout: { paidAt: null } },
    });
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
    const manual = await h.service.payout({ returnId, action: 'manual' });
    expect(manual).toMatchObject({ kind: 'paid_out', method: 'manual', slip: 'printed' });
    expect(h.drawer.kicks).toBe(1);
    expect(payoutCategories()).toEqual([
      'sale.return.payout_started',
      'sale.return.drawer_failed',
      'sale.return.paid_out',
      'sale.return.slip_printed',
    ]);
  });

  it('C3: the slip prints only after paid_out is committed; a print failure keeps the payout', async () => {
    const returnId = await confirmedReturn(h.service);
    let atPrint: [string | undefined, string[]] = [undefined, []];
    h.printer.answer = () => {
      atPrint = [h.repo.read(returnId)?.state, categories(h.audits)];
      return Promise.resolve({
        ok: false,
        render_path: 'os_print',
        failure_reason: 'printer_offline',
      });
    };
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(atPrint[0]).toBe('paid_out');
    expect(atPrint[1].at(-1)).toBe('sale.return.paid_out');
    expect(res).toMatchObject({ kind: 'paid_out', slip: 'failed', ret: { state: 'paid_out' } });
    expect(h.audits.at(-1)).toMatchObject({
      action_category: 'sale.return.slip_print_failed',
      payload: { copy: false, failure_reason: 'printer_offline' },
    });
  });

  it('C4: a crash while the slip prints leaves the payout recorded and the slip reprintable', async () => {
    const returnId = await confirmedReturn(h.service);
    h.printer.answer = () => new Promise(() => undefined);
    void h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.printer.printed).toHaveLength(1);
    });
    const after = h.restart();
    h.printer.answer = () => Promise.resolve({ ok: true, render_path: 'os_print' });
    expect(h.repo.read(returnId)?.state).toBe('paid_out');
    expect(await after.service.reprintSlip({ returnId })).toEqual({ kind: 'printed' });
    expect(h.printer.textOf(1)).toContain('COPY');
  });
});

describe('M: money', () => {
  it('M1/M2: pays, audits and prints the server-confirmed total and the journaled lines', async () => {
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    const confirmed = h.repo.read(returnId)?.returnTotalMinor;
    expect(confirmed).toBe(1500);
    const paid = h.audits.find((a) => a.action_category === 'sale.return.paid_out');
    expect(paid?.payload).toMatchObject({
      payout_minor: 1500,
      currency_code: 'EGP',
      tender: 'cash',
    });
    const slip = h.printer.textOf(0);
    expect(slip).toContain('1× Panadol 500mg');
    expect(slip).toContain('Refund total (cash): 15.00 EGP');
  });
});

describe('D: drawer', () => {
  it.each(['no_drawer_configured', 'printer_dk_failure', 'os_error'] as const)(
    'D1: a %s kick records no paid_out and audits why',
    async (failure_reason) => {
      const returnId = await confirmedReturn(h.service);
      h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason });
      const res = await h.service.payout({ returnId, action: 'start' });
      expect(res).toMatchObject({ kind: 'drawer_failed', reason: failure_reason });
      expect(h.repo.read(returnId)?.state).toBe('confirmed');
      expect(h.audits.at(-1)).toMatchObject({
        action_category: 'sale.return.drawer_failed',
        payload: { failure_reason },
      });
      expect(h.printer.printed).toHaveLength(0);
    },
  );

  it('D2: a throwing drawer is os_error', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.reject(new Error('usb'));
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'drawer_failed',
      reason: 'os_error',
    });
  });

  it('D2: a drawer that never answers times out without a payout', async () => {
    const returnId = await confirmedReturn(h.service);
    vi.useFakeTimers();
    h.drawer.answer = () => new Promise<DrawerKickResult>(() => undefined);
    const pending = h.service.payout({ returnId, action: 'start' });
    await vi.advanceTimersByTimeAsync(RETURN_DRAWER_TIMEOUT_MS);
    expect(await pending).toMatchObject({ kind: 'drawer_failed', reason: 'timeout' });
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });

  it('D2: retry_drawer after a kick that never left opens the drawer and pays out', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    await h.service.payout({ returnId, action: 'start' });
    h.drawer.answer = () => Promise.resolve({ ok: true });
    expect(await h.service.payout({ returnId, action: 'retry_drawer' })).toMatchObject({
      kind: 'paid_out',
      method: 'drawer',
    });
    expect(h.drawer.kicks).toBe(2);
  });
});

describe('S: slip', () => {
  it('S3: reprints only a paid-out return, marked as a copy and audited', async () => {
    const returnId = await confirmedReturn(h.service);
    expect(await h.service.reprintSlip({ returnId })).toMatchObject({
      kind: 'refused',
      reason: 'not_paid_out',
    });
    await h.service.payout({ returnId, action: 'start' });
    expect(h.printer.textOf(0)).not.toContain('COPY');
    expect(await h.service.reprintSlip({ returnId })).toEqual({ kind: 'printed' });
    expect(h.printer.textOf(1)).toContain('نسخة — COPY');
    expect(h.audits.at(-1)?.action_category).toBe('sale.return.slip_reprinted');
  });

  it('S4: a failed or throwing print keeps the payout and the reprint still works', async () => {
    const returnId = await confirmedReturn(h.service);
    h.printer.answer = () => Promise.reject(new Error('spooler'));
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({ slip: 'failed' });
    expect(h.audits.at(-1)?.payload).toMatchObject({ failure_reason: 'os_print_error' });
    h.printer.answer = () =>
      Promise.resolve({ ok: false, render_path: 'os_print', failure_reason: 'printer_jam' });
    expect(await h.service.reprintSlip({ returnId })).toEqual({ kind: 'print_failed' });
    expect(h.audits.at(-1)?.payload).toMatchObject({ copy: true, failure_reason: 'printer_jam' });
    h.printer.answer = () => Promise.resolve({ ok: true, render_path: 'os_print' });
    expect(await h.service.reprintSlip({ returnId })).toEqual({ kind: 'printed' });
    expect(h.repo.read(returnId)?.state).toBe('paid_out');
  });

  it('S3: a double-clicked reprint prints one copy', async () => {
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await Promise.all([h.service.reprintSlip({ returnId }), h.service.reprintSlip({ returnId })]);
    expect(h.printer.printed).toHaveLength(2);
  });
});

describe('Z: shutdown', () => {
  it('Z1: after stop nothing is read or written: no claim, no audit, no kick', async () => {
    const returnId = await confirmedReturn(h.service);
    const before = h.audits.length;
    h.stop();
    expect(await h.service.payout({ returnId, action: 'start' })).toEqual({
      kind: 'refused',
      reason: 'shutting_down',
      ret: null,
    });
    expect(await h.service.reprintSlip({ returnId })).toEqual({
      kind: 'refused',
      reason: 'shutting_down',
    });
    expect([h.audits.length, h.drawer.kicks, payoutRow(returnId)]).toEqual([before, 0, undefined]);
  });

  it('Z2: stop during the kick records only that kick (P1), and no payout', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const pending = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    h.stop();
    const before = h.audits.length;
    kick.resolve({ ok: true });
    expect(await pending).toMatchObject({ kind: 'refused', reason: 'shutting_down' });
    // P1: the opening is remembered even at quit; nothing else is written.
    expect(categories(h.audits.slice(before))).toEqual(['sale.return.drawer_opened']);
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });

  it('Z3: stop during the print writes no slip audit; the payout stays recorded', async () => {
    const returnId = await confirmedReturn(h.service);
    const print = deferredFake<{ ok: true; render_path: 'os_print' }>();
    h.printer.answer = () => print.promise;
    const pending = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.printer.printed).toHaveLength(1);
    });
    h.stop();
    const before = h.audits.length;
    print.resolve({ ok: true, render_path: 'os_print' });
    expect(await pending).toMatchObject({ kind: 'paid_out', slip: 'printed' });
    expect(h.audits.length).toBe(before);
    expect(h.repo.read(returnId)?.state).toBe('paid_out');
  });
});
