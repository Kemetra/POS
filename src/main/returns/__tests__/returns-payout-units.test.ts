/**
 * RT-15 S4 — the two independent guards behind X4 ("a started payout is never
 * started again"), each tested alone (end to end they mask each other):
 *   1. `payoutRefusal`, the state/started/action table;
 *   2. the claim's guarded insert: when the pre-read misses a row that another
 *      process inserted a moment later, the claim still refuses and the drawer
 *      never kicks.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ReturnPayoutAction, ReturnState } from '../../../shared/returns/types.js';
import { bindSalesRepository } from '../../sales/repositories/sales.repository.js';
import { createReturnsAudit } from '../returns-audit.js';
import { createReturnsAuthorizer } from '../returns-auth.js';
import { RETURN_KICK_LEASE_MS } from '../returns-drawer.js';
import {
  createReturnsPayoutService,
  kickInFlight,
  kickResultOf,
  payoutRefusal,
  type ReturnsPayoutDeps,
} from '../returns-payout.js';
import {
  createReturnPayoutsRepository,
  type ReturnPayoutsRepository,
} from '../returns-payout-repository.js';
import { toJournalView } from '../returns-views.js';
import {
  ENVELOPE,
  NOW,
  confirmedReturn,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  sessionFor,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

type Kick = 'none' | 'sending' | 'opened' | 'failed_before_send' | 'unknown' | null;

const KICKED_AT = '2026-10-04T10:00:00.000Z';
const WITHIN_LEASE = '2026-10-04T10:00:03.000Z';

/** null: no payout started; else the started payout's kick record. */
function started(kick: Kick) {
  if (kick === null) return null;
  const none = kick === 'none';
  return { kickOutcome: none ? null : kick, kickedAt: none ? null : KICKED_AT };
}

describe('payoutRefusal', () => {
  it.each<[ReturnState, Kick, ReturnPayoutAction, string | null]>([
    ['pending', null, 'start', 'not_payable'],
    ['unknown', null, 'manual', 'not_payable'],
    ['refused', null, 'retry_drawer', 'not_payable'],
    ['paid_out', 'opened', 'start', 'already_paid_out'],
    ['paid_out', 'opened', 'manual', 'already_paid_out'],
    ['confirmed', null, 'start', null],
    ['confirmed', 'sending', 'start', 'payout_started'],
    ['confirmed', null, 'retry_drawer', 'payout_not_started'],
    ['confirmed', null, 'manual', 'payout_not_started'],
    // P1: a retry only after a kick that provably never left.
    ['confirmed', 'none', 'retry_drawer', null],
    ['confirmed', 'failed_before_send', 'retry_drawer', null],
    ['confirmed', 'opened', 'retry_drawer', 'drawer_retry_unsafe'],
    ['confirmed', 'unknown', 'retry_drawer', 'drawer_retry_unsafe'],
    ['confirmed', 'sending', 'retry_drawer', 'drawer_retry_unsafe'],
    // Manual completes whatever the drawer did.
    ['confirmed', 'opened', 'manual', null],
    ['confirmed', 'unknown', 'manual', null],
    // Codex P1: a kick in flight (here, 3 s ago) holds the payout.
    ['confirmed', 'sending', 'manual', 'drawer_kick_in_progress'],
  ])('%s, kick %s, %s → %s', (state, kick, action, expected) => {
    expect(payoutRefusal(state, started(kick), action, WITHIN_LEASE)).toBe(expected);
  });

  it('a kick still sending after the lease (its process died) is completed manually only', () => {
    const after = new Date(Date.parse(KICKED_AT) + RETURN_KICK_LEASE_MS).toISOString();
    expect(payoutRefusal('confirmed', started('sending'), 'manual', after)).toBeNull();
    expect(payoutRefusal('confirmed', started('sending'), 'retry_drawer', after)).toBe(
      'drawer_retry_unsafe',
    );
  });
});

describe('kickInFlight (Codex P1 lease)', () => {
  it.each<[Kick, number, boolean]>([
    ['sending', 0, true],
    ['sending', RETURN_KICK_LEASE_MS - 1, true],
    ['sending', RETURN_KICK_LEASE_MS, false],
    // Reviewer P2: a backward clock jump bounds the lease, never extends it.
    ['sending', -RETURN_KICK_LEASE_MS, true],
    ['sending', -RETURN_KICK_LEASE_MS - 1, false],
    ['opened', 0, false],
    ['unknown', 0, false],
    ['none', 0, false],
  ])('kick %s, %i ms later → in flight %s', (kick, ms, expected) => {
    const now = new Date(Date.parse(KICKED_AT) + ms).toISOString();
    expect(kickInFlight(started(kick) ?? { kickOutcome: null, kickedAt: null }, now)).toBe(
      expected,
    );
  });
});

describe('kickResultOf', () => {
  it.each<[Parameters<typeof kickResultOf>[0], string]>([
    [{ ok: true }, 'opened'],
    [{ ok: false, reason: 'no_drawer_configured' }, 'failed_before_send'],
    [{ ok: false, reason: 'printer_dk_failure' }, 'unknown'],
    [{ ok: false, reason: 'os_error' }, 'unknown'],
    [{ ok: false, reason: 'timeout' }, 'unknown'],
  ])('%o proves %s', (kick, expected) => {
    expect(kickResultOf(kick)).toBe(expected);
  });
});

describe('the claim is a guarded insert', () => {
  let h: ReturnsHarness;

  beforeEach(() => {
    h = returnsHarness();
    seedSyncedSale(h.db);
  });

  afterEach(() => {
    h.close();
  });

  /** The payout service over the harness's real DB, with some deps replaced. */
  function serviceOver(overrides: Partial<ReturnsPayoutDeps>) {
    const payouts = createReturnPayoutsRepository(h.handle);
    return createReturnsPayoutService({
      authorizer: createReturnsAuthorizer({
        isEnabled: () => true,
        getSession: () => sessionFor('manager'),
        isSessionLocked: () => false,
        getEnvelope: () => ENVELOPE,
      }),
      repo: h.repo,
      payouts,
      sales: bindSalesRepository(h.handle),
      audit: createReturnsAudit({ sink: h.auditSink, now: () => 't', newEventId: randomUUID }),
      drawer: h.drawer,
      printer: h.printer,
      transaction: (fn) => h.handle.transaction(fn)(),
      isStopped: () => false,
      now: () => 't',
      view: (entry) => toJournalView(entry, payouts.read(entry.returnId)),
      ...overrides,
    });
  }

  it('another process claiming first is refused payout_started, with no kick', async () => {
    const returnId = await confirmedReturn(h.service);
    const payouts = createReturnPayoutsRepository(h.handle);
    // The other till process claims right after this one's pre-read.
    const racing: ReturnPayoutsRepository = Object.create(payouts, {
      read: {
        value: (id: string) => {
          const row = payouts.read(id);
          payouts.start({
            returnId: id,
            operatorId: 'op-other',
            sessionId: 'sess-other',
            now: 't',
          });
          return row;
        },
      },
    }) as ReturnPayoutsRepository;
    const res = await serviceOver({ payouts: racing }).payout({ returnId, action: 'start' });
    expect(res).toMatchObject({ kind: 'refused', reason: 'payout_started' });
    expect(h.drawer.kicks).toBe(0);
    expect(h.audits.map((a) => a.action_category)).not.toContain('sale.return.payout_started');
  });

  it('a slip that cannot be rendered after the commit is a failed slip, never a lost payout', async () => {
    const returnId = await confirmedReturn(h.service);
    const service = serviceOver({
      sales: {
        readById: () => {
          throw new Error('sales row unreadable');
        },
      },
    });
    const res = await service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({ kind: 'paid_out', slip: 'failed' });
    expect(h.repo.read(returnId)?.state).toBe('paid_out');
    expect(h.printer.printed).toHaveLength(0);
    expect(h.audits.at(-1)).toMatchObject({
      action_category: 'sale.return.slip_print_failed',
      payload: { failure_reason: 'os_print_error' },
    });
  });

  /** A payouts repository whose slip lines no longer add up to the confirmed total. */
  function mismatchedLines(): ReturnPayoutsRepository {
    const payouts = createReturnPayoutsRepository(h.handle);
    return Object.create(payouts, {
      slipLines: {
        value: (id: string) =>
          payouts.slipLines(id).map((l) => ({ ...l, amountMinor: (l.amountMinor ?? 0) - 1 })),
      },
    }) as ReturnPayoutsRepository;
  }

  it('P2-4: a slip whose lines do not add up is not printed; the payout stands; audited', async () => {
    const returnId = await confirmedReturn(h.service);
    const service = serviceOver({ payouts: mismatchedLines() });
    expect(await service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'paid_out',
      slip: 'failed',
    });
    expect(h.printer.printed).toHaveLength(0);
    expect(h.audits.at(-1)).toMatchObject({
      action_category: 'sale.return.slip_print_failed',
      payload: { copy: false, failure_reason: 'slip_total_mismatch' },
    });
  });

  it('P2-4: a reprint of such a slip is refused, not reported as a printer failure', async () => {
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    const service = serviceOver({ payouts: mismatchedLines() });
    expect(await service.reprintSlip({ returnId })).toEqual({
      kind: 'refused',
      reason: 'slip_total_mismatch',
    });
    expect(h.printer.printed).toHaveLength(1);
    expect(h.audits.at(-1)).toMatchObject({
      action_category: 'sale.return.slip_print_failed',
      payload: { copy: true, failure_reason: 'slip_total_mismatch' },
    });
  });

  /** A payouts repository on which `race` runs right after the pre-read (another instance). */
  function racingAfterRead(race: (payouts: ReturnPayoutsRepository, id: string) => void) {
    const payouts = createReturnPayoutsRepository(h.handle);
    return Object.create(payouts, {
      read: {
        value: (id: string) => {
          const row = payouts.read(id);
          race(payouts, id);
          return row;
        },
      },
    }) as ReturnPayoutsRepository;
  }

  it("Codex P2 (c21d7e2): losing the race to another instance's kick is drawer_kick_in_progress", async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    await h.service.payout({ returnId, action: 'start' });
    // The other instance starts a retry kick between this one's checks and its commit.
    const payouts = racingAfterRead((p, id) => p.markSending({ returnId: id, now: NOW }));
    const res = await serviceOver({ payouts, now: () => NOW }).payout({
      returnId,
      action: 'manual',
    });
    expect(res).toMatchObject({ kind: 'refused', reason: 'drawer_kick_in_progress' });
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });

  it("losing the race to another instance's completion is already_paid_out", async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
    await h.service.payout({ returnId, action: 'start' });
    const payouts = racingAfterRead((p, id) => {
      p.complete({
        returnId: id,
        operatorId: 'op-other',
        operatorName: null,
        sessionId: 'sess-other',
        method: 'manual',
        now: NOW,
      });
    });
    const res = await serviceOver({ payouts, now: () => NOW }).payout({
      returnId,
      action: 'manual',
    });
    expect(res).toMatchObject({ kind: 'refused', reason: 'already_paid_out' });
  });
});
