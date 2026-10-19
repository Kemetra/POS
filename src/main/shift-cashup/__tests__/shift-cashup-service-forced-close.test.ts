/**
 * RT-554 (owner decision 2026-10-19 (b)) — a manager's forced close of the
 * terminal's own open shift, from LOCAL truth: the open shift in
 * `shift_cashup_opens`, the cash-up computed from the local sales, returns and
 * movements, and the manager's COUNT. It writes the forced close row and an
 * original manager-envelope outbox row in one transaction; nothing is sent
 * here (the engine sends it under a manager envelope).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { ShiftCashupStateError } from '../shift-cashup-repo.js';
import { ShiftCashupRefusedError } from '../shift-cashup-service.js';
import {
  cashLine,
  factCounts,
  managerSession,
  MANAGER,
  OPENED_AT,
  seedSettlement,
  seedShiftSale,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { USER } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const CLOSE_AT = '2026-10-05T16:00:00.000Z';
const SHIFT_REASON = 'cashier_no_show';

let db: SqlJsDatabase;
let harness: ServiceHarness;
let shiftId: string;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db, { varianceApprovalThresholdMinor: null });
  shiftId = harness.service.openShift({ openingFloatMinor: FLOAT }).shiftId;
  // The cashier walked away; a manager signs in on the same terminal.
  harness.state.session = managerSession();
  harness.state.clock = CLOSE_AT;
});

afterEach(() => {
  db.close();
});

function forceClose(
  over: Partial<Parameters<ServiceHarness['service']['forceCloseShift']>[0]> = {},
) {
  return harness.service.forceCloseShift({
    shiftId,
    countedCashMinor: FLOAT,
    forcedReason: SHIFT_REASON,
    managerUserId: MANAGER,
    operatorSessionId: managerSession().operator_session_id,
    ...over,
  });
}

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ShiftCashupRefusedError || error instanceof ShiftCashupStateError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a forced close of the terminal’s own open shift', () => {
  it('records a forced close, closing user = the manager, totals from local truth', () => {
    seedShiftSale(db, {
      saleId: 'sale-1',
      finalizedAt: '2026-10-05T10:00:00.000Z',
      lines: [cashLine(10_000)],
    });

    const closed = forceClose({ countedCashMinor: 59_000 });

    expect(closed).toMatchObject({
      shiftId,
      cashSalesTotalMinor: 10_000,
      expectedCashMinor: 60_000,
      countedCashMinor: 59_000,
      varianceMinor: -1_000,
      saleCount: 1,
    });
    const close = db.exec(
      `SELECT close_kind, forced_reason, closing_user_id, opening_float_minor,
              counted_cash_minor, variance_minor FROM shift_cashup_closes`,
    )[0]?.values[0];
    expect(close).toEqual(['forced', SHIFT_REASON, MANAGER, FLOAT, 59_000, -1_000]);
  });

  it('queues ONE envelope-path close row: closeKind forced, no operatorUserId, the reason code only', () => {
    forceClose();

    const row = db.exec(`SELECT auth_path, fact_kind FROM shift_sync_outbox WHERE seq = 2`)[0]
      ?.values[0];
    expect(row).toEqual(['envelope', 'close']);
    const body = storedBody(db, 2);
    expect(body).toMatchObject({
      closeKind: 'forced',
      forcedReason: SHIFT_REASON,
      closingUserId: MANAGER,
      countedCash: '500.00',
    });
    expect(body).not.toHaveProperty('operatorUserId');
  });

  it('leaves the terminal with no open shift, so a new one can be opened', () => {
    forceClose();
    harness.state.session = null;
    expect(factCounts(db)).toMatchObject({ shift_cashup_closes: 1 });
  });

  it('matches the shift id case-insensitively', () => {
    expect(forceClose({ shiftId: shiftId.toUpperCase() }).shiftId).toBe(shiftId);
  });
});

describe('onRecorded (the audit hook) shares the close transaction', () => {
  it('is called once with the close and the shift owner (the opening user), after the rows exist', () => {
    const seen: Array<{ shiftId: string; openingUserId: string; closes: number }> = [];

    forceClose({
      onRecorded: (closed) =>
        seen.push({
          shiftId: closed.shiftId,
          openingUserId: closed.openingUserId,
          closes: Number(db.exec('SELECT COUNT(*) FROM shift_cashup_closes')[0]?.values[0]?.[0]),
        }),
    });

    expect(seen).toEqual([{ shiftId, openingUserId: USER, closes: 1 }]);
  });

  it('a throw in the hook leaves the shift open and writes nothing', () => {
    const counts = factCounts(db);

    expect(() =>
      forceClose({
        onRecorded: () => {
          throw new Error('audit store unavailable');
        },
      }),
    ).toThrow('audit store unavailable');

    expect(factCounts(db)).toEqual(counts);
  });
});

describe('what it refuses, writing nothing', () => {
  const before = () => factCounts(db);

  it('a shift id that is not the terminal’s open shift is shift_not_open', () => {
    const counts = before();
    expect(reasonOf(() => forceClose({ shiftId: '0192f5a2-3b4c-7d8e-9f01-ffffffffffff' }))).toBe(
      'shift_not_open',
    );
    expect(factCounts(db)).toEqual(counts);
  });

  it('with no open shift at all is shift_not_open', () => {
    forceClose();
    expect(reasonOf(() => forceClose())).toBe('shift_not_open');
  });

  it.each([
    ['the flag is off', () => (harness.state.enabled = false), 'feature_disabled'],
    ['there is no session', () => (harness.state.session = null), 'no_session'],
    ['the session is locked', () => (harness.state.locked = true), 'session_locked'],
  ])('refuses when %s', (_name, change, reason) => {
    change();
    expect(reasonOf(() => forceClose())).toBe(reason);
    expect(factCounts(db)).toMatchObject({ shift_cashup_closes: 0 });
  });

  it('refuses a session other than the one the caller checked (no_session)', () => {
    expect(reasonOf(() => forceClose({ operatorSessionId: 'another-session' }))).toBe('no_session');
  });

  it('refuses an implausible count (amount_out_of_range) before anything is read', () => {
    expect(reasonOf(() => forceClose({ countedCashMinor: 100_000_001 }))).toBe(
      'amount_out_of_range',
    );
  });

  it('refuses while drawer cash is in flight (drawer_activity_pending)', () => {
    seedSettlement(db, { saleId: 'sale-in-flight' });
    expect(reasonOf(() => forceClose())).toBe('drawer_activity_pending');
    expect(factCounts(db)).toMatchObject({ shift_cashup_closes: 0 });
  });

  it('applies the configured variance policy: the manager is the closer, so a variance past it is refused', () => {
    const strict = serviceHarness(db, { varianceApprovalThresholdMinor: 0 });
    strict.state.session = managerSession();
    strict.state.clock = CLOSE_AT;
    expect(
      reasonOf(() =>
        strict.service.forceCloseShift({
          shiftId,
          countedCashMinor: FLOAT - 1,
          forcedReason: SHIFT_REASON,
          managerUserId: MANAGER,
          operatorSessionId: managerSession().operator_session_id,
        }),
      ),
    ).toBe('variance_approval_required');
  });

  it('refuses a clock before the open (clock_regressed)', () => {
    harness.state.clock = new Date(Date.parse(OPENED_AT) - 1).toISOString();
    expect(reasonOf(() => forceClose())).toBe('clock_regressed');
  });
});
