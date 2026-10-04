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
import {
  createReturnsPayoutService,
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

describe('payoutRefusal', () => {
  it.each<[ReturnState, boolean, ReturnPayoutAction, string | null]>([
    ['pending', false, 'start', 'not_payable'],
    ['unknown', false, 'manual', 'not_payable'],
    ['refused', false, 'retry_drawer', 'not_payable'],
    ['paid_out', true, 'start', 'already_paid_out'],
    ['paid_out', true, 'manual', 'already_paid_out'],
    ['confirmed', false, 'start', null],
    ['confirmed', true, 'start', 'payout_started'],
    ['confirmed', false, 'retry_drawer', 'payout_not_started'],
    ['confirmed', false, 'manual', 'payout_not_started'],
    ['confirmed', true, 'retry_drawer', null],
    ['confirmed', true, 'manual', null],
  ])('%s, started %s, %s → %s', (state, started, action, expected) => {
    expect(payoutRefusal(state, started, action)).toBe(expected);
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
});
