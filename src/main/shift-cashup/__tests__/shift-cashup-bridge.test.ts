/**
 * RT-17 slice 4 part 1 — the main-side `shiftCashup.*` bridge over the real
 * service (migration stack on sql.js):
 *
 *   • every typed refusal becomes a closed `{ kind: 'refused', reason }`
 *     envelope; the precise reason is logged main-side only;
 *   • probing (10941 item 3): a pay-out above the expected drawer cash is
 *     answered with the generic `pay_out_not_accepted` (no amount, no bound),
 *     and a non-zero variance with `variance_approval_unavailable`;
 *   • zero-variance close only: the bridge never passes an approver to the
 *     service (the verified-manager approver waits for 10942);
 *   • nothing that reveals the expected cash, and no `users.id`, reaches the
 *     renderer: the close answers its id and time only, and the status is an
 *     explicit allowlist.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ShiftCashupBridgeAPI } from '../../../shared/shift-cashup/types.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createShiftCashupBridge,
  SHIFT_CASHUP_FAILED_LOG,
  SHIFT_CASHUP_REFUSED_LOG,
} from '../shift-cashup-bridge.js';
import { ShiftCashupStateError } from '../shift-cashup-repo.js';
import type { ShiftCashupService } from '../shift-cashup-service.js';
import {
  CLOSED_AT,
  MANAGER,
  OPENED_AT,
  cashLine,
  factCounts,
  seedSettlement,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { SCOPE, USER } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const ANY_ID = expect.any(String) as string;

let db: SqlJsDatabase;
let harness: ServiceHarness;
type LogFn = (payload: Record<string, unknown>, message: string) => void;
let logger: { info: Mock<LogFn>; warn: Mock<LogFn> };
let bridge: ShiftCashupBridgeAPI;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
  logger = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>() };
  bridge = createShiftCashupBridge({ service: harness.service, logger });
});

afterEach(() => {
  db.close();
});

function refused(reason: string): unknown {
  return { kind: 'refused', reason };
}

/** Open at `OPENED_AT` with `FLOAT` and move the clock to `CLOSED_AT`. */
async function openShift(): Promise<string> {
  const opened = await bridge.open({ openingFloatMinor: FLOAT });
  if (opened.kind !== 'opened') throw new Error('fixture: open refused');
  harness.state.clock = CLOSED_AT;
  return opened.shiftId;
}

const payOut = (amountMinor: number) => bridge.payOut({ amountMinor, reasonCode: 'bank_drop' });

describe('recorded facts', () => {
  it('opens a shift and answers its id and time only', async () => {
    const opened = await bridge.open({ openingFloatMinor: FLOAT });
    expect(opened).toEqual({ kind: 'opened', shiftId: ANY_ID, openedAt: OPENED_AT });
  });

  it.each([
    ['payIn', 'pay_in'],
    ['payOut', 'pay_out'],
  ] as const)('%s records a %s movement, with its note', async (member, kind) => {
    const shiftId = await openShift();
    const req = { amountMinor: 100, reasonCode: 'other', note: 'till 2' } as const;
    await expect(bridge[member](req)).resolves.toEqual({
      kind: 'recorded',
      movementId: ANY_ID,
      shiftId,
    });
    expect(storedBody(db, 2)).toMatchObject({ kind, amount: '1.00', note: 'till 2' });
  });

  it('records a movement without a note', async () => {
    await openShift();
    await bridge.payIn({ amountMinor: 100, reasonCode: 'float_top_up' });
    expect(storedBody(db, 2)).not.toHaveProperty('note');
  });

  it('closes a zero-variance shift and answers its id and time only', async () => {
    const shiftId = await openShift();
    await expect(bridge.close({ countedCashMinor: FLOAT })).resolves.toEqual({
      kind: 'closed',
      shiftId,
      closedAt: CLOSED_AT,
    });
  });
});

describe('zero-variance close only (the approver waits for 10942)', () => {
  it.each([FLOAT - 1, FLOAT + 1])(
    'refuses a count of %i as variance_approval_unavailable, writing nothing',
    async (countedCashMinor) => {
      await openShift();
      const before = factCounts(db);
      await expect(bridge.close({ countedCashMinor })).resolves.toEqual(
        refused('variance_approval_unavailable'),
      );
      expect(factCounts(db)).toEqual(before);
      expect(logger.info).toHaveBeenCalledWith(
        { op: 'close', reason: 'variance_approval_required' },
        SHIFT_CASHUP_REFUSED_LOG,
      );
    },
  );

  it('never passes an approver to the service, even if one is smuggled in', async () => {
    await openShift();
    const smuggled = { countedCashMinor: FLOAT + 1, varianceApprovedByUserId: MANAGER };
    await expect(bridge.close(smuggled)).resolves.toEqual(refused('variance_approval_unavailable'));
  });
});

describe('pay-out probing (10941 item 3)', () => {
  it('answers a pay-out above the expected drawer cash with the generic refusal only', async () => {
    await openShift();
    const answer = await payOut(FLOAT + 1);
    expect(answer).toStrictEqual(refused('pay_out_not_accepted'));
    expect(logger.info).toHaveBeenCalledWith(
      { op: 'payOut', reason: 'pay_out_exceeds_drawer_cash' },
      SHIFT_CASHUP_REFUSED_LOG,
    );
  });

  it('shows the count of probe refusals in the status', async () => {
    await openShift();
    await payOut(FLOAT + 1);
    await payOut(FLOAT + 7);
    await bridge.close({ countedCashMinor: 1 });
    const status = await bridge.status();
    expect(status).toMatchObject({
      kind: 'status',
      status: { probeRefusals: { payOut: 2, varianceClose: 1 } },
    });
  });
});

describe('refusal mapping', () => {
  type Arrange = () => unknown;
  const none: Arrange = () => undefined;
  const set =
    (patch: Partial<ServiceHarness['state']>): Arrange =>
    () =>
      Object.assign(harness.state, patch);
  const openThen =
    (then: () => void): Arrange =>
    async () => {
      await openShift();
      then();
    };
  const call = {
    open: () => bridge.open({ openingFloatMinor: FLOAT }),
    payIn: () => bridge.payIn({ amountMinor: 1, reasonCode: 'other' }),
    payOut: () => payOut(1),
    close: () => bridge.close({ countedCashMinor: FLOAT }),
    status: () => bridge.status(),
  };
  const MANAGER_SESSION = {
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    terminal_id: SCOPE.terminalId,
  };
  const unreadableTender = () => {
    seedShiftSale(db, { saleId: 's-1', finalizedAt: OPENED_AT, lines: [{ tender_type: 'x' }] });
  };

  it.each<[string, Arrange, keyof typeof call, string]>([
    ['the flag off', set({ enabled: false }), 'payIn', 'feature_disabled'],
    ['no session', set({ session: null }), 'open', 'no_session'],
    ['a locked session', set({ locked: true }), 'close', 'session_locked'],
    ['no users.id', set({ session: MANAGER_SESSION }), 'open', 'no_cashier_identity'],
    ['an open shift', openThen(none), 'open', 'shift_already_open'],
    ['no open shift', none, 'payIn', 'shift_not_open'],
    [
      'a clock behind the open',
      openThen(() => (harness.state.clock = '2026-10-05T07:00:00.000Z')),
      'payIn',
      'clock_regressed',
    ],
    [
      'drawer activity in flight',
      openThen(() => {
        seedSettlement(db, { saleId: 's-1' });
      }),
      'payOut',
      'drawer_activity_pending',
    ],
    ['an unreadable sale tender', openThen(unreadableTender), 'close', 'cashup_unavailable'],
    ['the flag off (status)', set({ enabled: false }), 'status', 'feature_disabled'],
    ['no session (status)', set({ session: null }), 'status', 'no_session'],
    ['a locked session (status)', set({ locked: true }), 'status', 'session_locked'],
  ])('with %s, %s is refused %s', async (_name, arrange, member, reason) => {
    await arrange();
    await expect(call[member]()).resolves.toEqual(refused(reason));
  });

  it('maps a fact the POS refuses to record to invalid_input (field and reason logged)', async () => {
    await expect(bridge.open({ openingFloatMinor: -1 })).resolves.toEqual(refused('invalid_input'));
    expect(logger.info).toHaveBeenCalledWith(
      { op: 'open', reason: 'invalid_amount' },
      SHIFT_CASHUP_REFUSED_LOG,
    );
  });

  function failingWith(thrown: unknown): ShiftCashupBridgeAPI {
    const service = {
      openShift: () => {
        throw thrown;
      },
    } as unknown as ShiftCashupService;
    return createShiftCashupBridge({ service, logger });
  }

  it.each<[string, unknown, string]>([
    ['an Error', new TypeError(`secret ${String(FLOAT)}`), 'TypeError'],
    ['a non-Error', `secret ${String(FLOAT)}`, 'string'],
  ])('answers %s as unavailable and logs its name only', async (_name, thrown, name) => {
    await expect(failingWith(thrown).open({ openingFloatMinor: 1 })).resolves.toEqual(
      refused('unavailable'),
    );
    expect(logger.warn).toHaveBeenCalledWith({ op: 'open', error: name }, SHIFT_CASHUP_FAILED_LOG);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it('answers a repair-state error (not a renderer state) as unavailable', async () => {
    const bridgeOverRepair = failingWith(new ShiftCashupStateError('not_dead_lettered'));
    await expect(bridgeOverRepair.open({ openingFloatMinor: 1 })).resolves.toEqual(
      refused('unavailable'),
    );
  });
});

describe('status: nothing that reveals the expected cash, no users.id', () => {
  it('is an explicit allowlist of the open shift, counts and probe refusals', async () => {
    const shiftId = await openShift();
    seedShiftSale(db, { saleId: 's-1', finalizedAt: OPENED_AT, lines: [cashLine(1_234)] });
    await bridge.payIn({ amountMinor: 100, reasonCode: 'other' });
    const status = await bridge.status();
    expect(status).toStrictEqual({
      kind: 'status',
      status: {
        openShift: {
          shiftId,
          openedAt: OPENED_AT,
          currencyCode: 'EGP',
          openingFloatMinor: FLOAT,
          payInTotalMinor: 100,
          payOutTotalMinor: 0,
        },
        queue: { pending: 2, waiting: 0, blocked: 0, envelopePending: 0 },
        stranded: { unsyncedFacts: 0, openShifts: 0 },
        pendingDrawerActivity: { refundPayouts: 0, unfinalizedSales: 0 },
        probeRefusals: { payOut: 0, varianceClose: 0 },
      },
    });
    const text = JSON.stringify(status);
    expect(text).not.toContain(USER);
    expect(text).not.toMatch(/expected/i);
    // float + sales + pay-in: the hidden expected cash appears nowhere.
    expect(text).not.toContain(String(FLOAT + 1_234 + 100));
  });

  it('answers no open shift as null', async () => {
    await expect(bridge.status()).resolves.toMatchObject({ status: { openShift: null } });
  });
});
