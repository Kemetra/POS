/**
 * RT-15 S4 — the payout repository over migration 0040: a payout starts once,
 * completes once (moving the header to paid_out in the same step), and the
 * slip lines come back with their journaled name and amount.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createReturnsRepository, type ReturnsRepository } from '../returns-repository.js';
import {
  createReturnPayoutsRepository,
  type CompletePayoutInput,
  type ReturnPayoutsRepository,
} from '../returns-payout-repository.js';
import { RETURN_KICK_LEASE_MS } from '../returns-drawer.js';
import { LINE_A, LINE_B, RETURN_REF, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

let db: SqlJsDatabase;
let journal: ReturnsRepository;
let payouts: ReturnPayoutsRepository;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
  journal = createReturnsRepository(handleFor(db));
  payouts = createReturnPayoutsRepository(handleFor(db));
  journal.insert(
    {
      returnId: 'r1',
      scope: SCOPE,
      saleId: 'sale-1',
      saleNumber: 'SN-sale-1',
      serverSaleRef: SALE_REF,
      externalId: `pos-pulse-return:${SALE_REF}`,
      operatorId: 'op-returner',
      operatorSessionId: 'sess-returner',
      currencyCode: 'EGP',
      quotedTotalMinor: 3500,
      requestBodyJson: '{}',
      lines: [
        { lineRef: LINE_A, quantity: 1 },
        { lineRef: LINE_B, quantity: 2 },
      ],
      now: 't0',
    },
    () => {
      payouts.recordLineDetails('r1', [
        { lineRef: LINE_A, lineName: 'Panadol 500mg', amountMinor: 1500 },
        { lineRef: LINE_B, lineName: null, amountMinor: 2000 },
      ]);
    },
  );
});

afterEach(() => {
  db.close();
});

function confirm(): void {
  journal.markConfirmed({
    returnId: 'r1',
    returnRef: RETURN_REF,
    returnTotalMinor: 3500,
    now: 't1',
  });
}

const START = { returnId: 'r1', operatorId: 'op-m', sessionId: 'sess-m', now: 't2' };
const COMPLETE: CompletePayoutInput = {
  returnId: 'r1',
  operatorId: 'op-a',
  operatorName: 'Admin One',
  sessionId: 'sess-a',
  method: 'drawer',
  now: 't3',
};

describe('return payouts repository', () => {
  it('has no payout until one is started', () => {
    confirm();
    expect(payouts.read('r1')).toBeNull();
  });

  it('starts a payout once, unpaid', () => {
    confirm();
    expect(payouts.start(START)).toBe(true);
    expect(payouts.start({ ...START, operatorId: 'op-other', now: 't9' })).toBe(false);
    expect(payouts.read('r1')).toEqual({
      returnId: 'r1',
      startedOperatorId: 'op-m',
      startedSessionId: 'sess-m',
      startedAt: 't2',
      paidOperatorId: null,
      paidOperatorName: null,
      paidSessionId: null,
      paidAt: null,
      method: null,
      kickOutcome: null,
      kickCount: 0,
      kickedAt: null,
    });
  });

  it('refuses to start a payout for a return that is not confirmed', () => {
    expect(() => payouts.start(START)).toThrow(/only for a confirmed return/);
  });

  it('completes once: the payout row and the header move together', () => {
    confirm();
    payouts.start(START);
    payouts.markSending({ returnId: 'r1', now: 'k1' });
    payouts.recordKick({ returnId: 'r1', outcome: 'opened' });
    expect(payouts.complete(COMPLETE)).toBe('completed');
    expect(payouts.complete({ ...COMPLETE, method: 'manual', now: 't4' })).toBe('already_paid');
    expect(payouts.read('r1')).toMatchObject({
      startedOperatorId: 'op-m',
      paidOperatorId: 'op-a',
      paidOperatorName: 'Admin One',
      paidSessionId: 'sess-a',
      paidAt: 't3',
      method: 'drawer',
    });
    expect(journal.read('r1')?.state).toBe('paid_out');
  });

  it('never completes a payout that was not started', () => {
    confirm();
    expect(payouts.complete(COMPLETE)).toBe('not_started');
    expect(journal.read('r1')?.state).toBe('confirmed');
  });

  it('P1: records one kick, and a second only after a kick that provably never left', () => {
    confirm();
    payouts.start(START);
    expect(payouts.markSending({ returnId: 'r1', now: 'k1' })).toBe(true);
    expect(payouts.markSending({ returnId: 'r1', now: 'k1b' })).toBe(false);
    expect(payouts.recordKick({ returnId: 'r1', outcome: 'failed_before_send' })).toBe(true);
    expect(payouts.recordKick({ returnId: 'r1', outcome: 'opened' })).toBe(false);
    expect(payouts.markSending({ returnId: 'r1', now: 'k2' })).toBe(true);
    expect(payouts.recordKick({ returnId: 'r1', outcome: 'opened' })).toBe(true);
    expect(payouts.markSending({ returnId: 'r1', now: 'k3' })).toBe(false);
    expect(payouts.read('r1')).toMatchObject({
      kickOutcome: 'opened',
      kickCount: 2,
      kickedAt: 'k2',
    });
  });

  it('P1: an unknown kick is final for the drawer', () => {
    confirm();
    payouts.start(START);
    payouts.markSending({ returnId: 'r1', now: 'k1' });
    payouts.recordKick({ returnId: 'r1', outcome: 'unknown' });
    expect(payouts.markSending({ returnId: 'r1', now: 'k2' })).toBe(false);
  });

  it('P1: completes by drawer only after the drawer opened; manually at any time', () => {
    confirm();
    payouts.start(START);
    payouts.markSending({ returnId: 'r1', now: 'k1' });
    payouts.recordKick({ returnId: 'r1', outcome: 'unknown' });
    expect(payouts.complete(COMPLETE)).toBe('drawer_not_opened');
    expect(journal.read('r1')?.state).toBe('confirmed');
    expect(payouts.complete({ ...COMPLETE, method: 'manual' })).toBe('completed');
    expect(journal.read('r1')?.state).toBe('paid_out');
  });

  it('fails closed (throws) if the header did not move with the payout', () => {
    confirm();
    payouts.start(START);
    // Unreachable through the schema today (0040 trigger); simulate the drift.
    db.run('DROP TRIGGER trg_return_journal_paid_out_needs_payout');
    db.run(
      `UPDATE return_journal SET state = 'paid_out', paid_out_at = 't9' WHERE return_id = 'r1'`,
    );
    expect(() => payouts.complete({ ...COMPLETE, method: 'manual' })).toThrow(
      /header is not confirmed/,
    );
  });

  it.each<[number, boolean]>([
    [0, false],
    [RETURN_KICK_LEASE_MS - 1, false],
    [RETURN_KICK_LEASE_MS, true],
    // Reviewer P2: a backward clock jump bounds the lease, never extends it.
    [-RETURN_KICK_LEASE_MS, false],
    [-RETURN_KICK_LEASE_MS - 1, true],
  ])('Codex P1 lease: a manual completion %i ms after a kick still sending: %s', (ms, ok) => {
    confirm();
    payouts.start(START);
    const kickedAt = '2026-10-04T10:00:00.000Z';
    payouts.markSending({ returnId: 'r1', now: kickedAt });
    const now = new Date(Date.parse(kickedAt) + ms).toISOString();
    // The guarded UPDATE answers false (never relies on the trigger throwing).
    expect(payouts.complete({ ...COMPLETE, method: 'manual', now })).toBe(
      ok ? 'completed' : 'kick_in_progress',
    );
    expect(journal.read('r1')?.state).toBe(ok ? 'paid_out' : 'confirmed');
  });

  it('stores a null operator name as null', () => {
    confirm();
    payouts.start(START);
    payouts.complete({ ...COMPLETE, operatorName: null, method: 'manual' });
    expect(payouts.read('r1')?.paidOperatorName).toBeNull();
  });

  it('returns the slip lines with their journaled name and amount, in line order', () => {
    expect(payouts.slipLines('r1')).toEqual([
      { lineRef: LINE_A, quantity: 1, lineName: 'Panadol 500mg', amountMinor: 1500 },
      { lineRef: LINE_B, quantity: 2, lineName: null, amountMinor: 2000 },
    ]);
  });

  it('returns slip lines without details for a return journaled before 0040', () => {
    journal.insert({
      ...(journal.read('r1') as NonNullable<ReturnType<ReturnsRepository['read']>>),
      returnId: 'r2',
      externalId: `pos-pulse-return:${RETURN_REF}`,
      now: 't0',
    });
    expect(payouts.slipLines('r2')).toEqual([
      { lineRef: LINE_A, quantity: 1, lineName: null, amountMinor: null },
      { lineRef: LINE_B, quantity: 2, lineName: null, amountMinor: null },
    ]);
  });

  it('lists the payouts of several returns at once', () => {
    confirm();
    payouts.start(START);
    expect([...payouts.readMany(['r1', 'r404']).keys()]).toEqual(['r1']);
    expect(payouts.readMany([]).size).toBe(0);
  });
});
