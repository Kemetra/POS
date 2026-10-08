/**
 * RT-17 slice 3 part 3 — the read-only shift cash-up status:
 *
 *   • the current pairing's open shift (its float and movement totals; never
 *     the expected cash — the cashier's count is blind, 10920);
 *   • the current terminal's unsettled outbox rows, by state: `pending` (due),
 *     `waiting` (in backoff), `blocked` (dead-lettered; the drain stops there)
 *     and `envelopePending` (a manager-envelope repair waiting for its client);
 *   • carried item (b): what is stranded outside the current pairing's scope —
 *     unsynced facts and open shifts of another terminal (a re-pair), or of
 *     every terminal while unpaired. The drain never sends them (RT-221);
 *   • review P2-2: the current terminal's drawer activity in flight, which
 *     holds the close — refund payouts started but not completed, and settled
 *     payments not finalized into a sale yet.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createShiftCashupRepo,
  type ShiftCashupRepo,
  type ShiftScope,
} from '../shift-cashup-repo.js';
import type { ShiftCashupServiceStatus } from '../shift-cashup-service.js';
import { createShiftCashupStatusReader } from '../shift-cashup-status.js';
import {
  OPENED_AT,
  msAfter,
  seedRefund,
  seedSettlement,
  serviceHarness,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import {
  NOW,
  OPEN,
  OTHER_TERMINAL,
  SCOPE,
  recordWholeShift,
} from './__helpers__/shift-sync-fixture.js';

let db: SqlJsDatabase;
let repo: ShiftCashupRepo;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  repo = createShiftCashupRepo(handleFor(db));
  harness = serviceHarness(db);
  harness.state.clock = NOW;
});

afterEach(() => {
  db.close();
});

const EMPTY_QUEUE = { pending: 0, waiting: 0, blocked: 0, envelopePending: 0 };
const NOT_STRANDED = { unsyncedFacts: 0, openShifts: 0 };
const NO_DRAWER_ACTIVITY = { refundPayouts: 0, unfinalizedSales: 0 };
const NO_PROBES = { payOut: 0, varianceClose: 0, approverFailure: 0 };
const REF_A = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const REF_B = '0192f5a2-3b4c-7d8e-9f01-0000000000b2';

function status(): Promise<ShiftCashupServiceStatus> {
  return harness.service.readStatus();
}

function openOn(scope: ShiftScope): void {
  repo.recordOpen({ scope, fact: OPEN, now: NOW });
}

describe('readStatus — the current terminal', () => {
  it('is empty with no shift and no queued fact', async () => {
    await expect(status()).resolves.toEqual({
      openShift: null,
      queue: EMPTY_QUEUE,
      stranded: NOT_STRANDED,
      pendingDrawerActivity: NO_DRAWER_ACTIVITY,
      probeRefusals: NO_PROBES,
    });
  });

  it('counts the drawer activity in flight on the current terminal only (review P2-2)', async () => {
    seedRefund(db, { returnId: 'r-1', returnRef: REF_A, amountMinor: 1, paidAt: null });
    seedRefund(db, { returnId: 'r-2', returnRef: REF_B, amountMinor: 1, paidAt: OPENED_AT });
    seedSettlement(db, { saleId: 's-1' });
    seedSettlement(db, { saleId: 's-2' });
    seedSettlement(db, { saleId: 's-x', scope: OTHER_TERMINAL });
    expect((await status()).pendingDrawerActivity).toEqual({
      refundPayouts: 1,
      unfinalizedSales: 2,
    });
  });

  it('shows the open shift (no expected cash) and its pending facts', async () => {
    harness.state.clock = OPENED_AT;
    const { shiftId } = harness.service.openShift({ openingFloatMinor: 50_000 });
    harness.service.recordCashMovement({ kind: 'pay_in', amountMinor: 1_000, reasonCode: 'other' });
    const read = await status();
    expect(read.openShift).toEqual({
      shiftId,
      openedAt: OPENED_AT,
      openingUserId: OPEN.openingUserId,
      currencyCode: 'EGP',
      openingFloatMinor: 50_000,
      payInTotalMinor: 1_000,
      payOutTotalMinor: 0,
    });
    expect(read.queue).toEqual({ ...EMPTY_QUEUE, pending: 2 });
  });

  it('shows no open shift once it is closed', async () => {
    recordWholeShift({ repo });
    expect((await status()).openShift).toBeNull();
  });

  it.each<[string, (r: ShiftCashupRepo) => void, typeof EMPTY_QUEUE]>([
    ['nothing sent yet', () => undefined, { ...EMPTY_QUEUE, pending: 3 }],
    [
      'a head in backoff',
      (r) => r.recordRetry({ seq: 1, now: NOW, nextRetryAt: msAfter(NOW), category: 'transient' }),
      { ...EMPTY_QUEUE, pending: 2, waiting: 1 },
    ],
    [
      'a retry due exactly now',
      (r) => r.recordRetry({ seq: 1, now: NOW, nextRetryAt: NOW, category: 'no_connection' }),
      { ...EMPTY_QUEUE, pending: 3 },
    ],
    [
      'a dead-lettered head',
      (r) => r.markDeadLetter({ seq: 1, now: NOW, reason: 'shift_closed' }),
      { ...EMPTY_QUEUE, pending: 2, blocked: 1 },
    ],
    [
      'an envelope repair of the dead letter',
      (r) => {
        r.markDeadLetter({ seq: 1, now: NOW, reason: 'cashier_claim_refused' });
        r.recordEnvelopeRepair({ seq: 1, now: NOW });
      },
      { ...EMPTY_QUEUE, pending: 2, envelopePending: 1 },
    ],
    ['a synced head', (r) => r.markSynced({ seq: 1, now: NOW }), { ...EMPTY_QUEUE, pending: 2 }],
  ])('counts the queue with %s', async (_name, arrange, queue) => {
    recordWholeShift({ repo });
    arrange(repo);
    const read = await status();
    expect(read.queue).toEqual(queue);
    expect(read.stranded).toEqual(NOT_STRANDED);
  });
});

describe('readStatus — stranded outside the current pairing (carried item b)', () => {
  it.each<[string, ShiftScope]>([
    ['another terminal', OTHER_TERMINAL],
    ['another branch', { ...SCOPE, branchId: 'branch-2' }],
    ['another tenant', { ...SCOPE, tenantId: 'tenant-2' }],
  ])('counts the unsynced facts and open shift of %s', async (_name, scope) => {
    openOn(scope);
    const read = await status();
    expect(read.stranded).toEqual({ unsyncedFacts: 1, openShifts: 1 });
    expect(read.queue).toEqual(EMPTY_QUEUE);
    expect(read.openShift).toBeNull();
  });

  it('stops counting a synced fact, keeps counting the still-open shift', async () => {
    openOn(OTHER_TERMINAL);
    repo.markSynced({ seq: 1, now: NOW });
    expect((await status()).stranded).toEqual({ unsyncedFacts: 0, openShifts: 1 });
  });

  it('counts a dead-lettered foreign fact but not a closed foreign shift', async () => {
    recordWholeShift({ repo, scope: OTHER_TERMINAL });
    repo.markDeadLetter({ seq: 1, now: NOW, reason: 'rejected' });
    expect((await status()).stranded).toEqual({ unsyncedFacts: 3, openShifts: 0 });
  });

  it('counts everything as stranded while unpaired', () => {
    openOn(SCOPE);
    seedSettlement(db, { saleId: 's-1' });
    // The reader itself: the service refuses a status with no paired scope
    // (no session on an unpaired terminal; review round 1).
    const reader = createShiftCashupStatusReader(handleFor(db));
    expect(reader.read({ scope: null, now: NOW })).toEqual({
      openShift: null,
      queue: EMPTY_QUEUE,
      stranded: { unsyncedFacts: 1, openShifts: 1 },
      pendingDrawerActivity: NO_DRAWER_ACTIVITY,
    });
  });

  it('reads with the service clock', async () => {
    recordWholeShift({ repo });
    const retryAt = msAfter(msAfter(NOW));
    repo.recordRetry({ seq: 1, now: NOW, nextRetryAt: retryAt, category: 'transient' });
    harness.state.clock = msAfter(NOW);
    expect((await status()).queue.waiting).toBe(1);
    harness.state.clock = retryAt;
    expect((await status()).queue.waiting).toBe(0);
  });
});
