/**
 * RT-17 slice 4 part 1 — what the service adds for its IPC (10941 "Slice 4
 * must" items 2 and 3):
 *
 *   • `readStatus` is gated on the flag AND an unlocked operator session on
 *     the paired terminal (any role: a manager reads it too), in that order;
 *   • the refusals that answer a probe of the blind count are tallied per
 *     shift, in memory, and shown in the status (`probeRefusals`): a pay-out
 *     refused above the expected drawer cash, and a close refused for a
 *     non-zero variance without an approver. Other refusals are not probes
 *     and are not counted. The tally starts at zero for the next shift.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PairingStatus } from '../../../shared/pairing-types.js';
import { pairedShiftScope } from '../compose-shift-cashup.js';
import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  CLOSED_AT,
  OPENED_AT,
  CASHIER_SESSION_ID,
  cashLine,
  cashierSession,
  managerSession,
  msAfter,
  seedSettlement,
  seedShiftSale,
  serviceHarness,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';
import { OTHER_TERMINAL } from './__helpers__/shift-sync-fixture.js';

const FLOAT = 50_000;
const NO_PROBES = { payOut: 0, varianceClose: 0, approverFailure: 0 };

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db);
});

afterEach(() => {
  db.close();
});

function refusal(reason: string): Error {
  return expect.objectContaining({ name: 'ShiftCashupRefusedError', reason }) as Error;
}

/** Open at `OPENED_AT` with `FLOAT` and move the clock to `CLOSED_AT`. */
function openShift(): string {
  const { shiftId } = harness.service.openShift({ openingFloatMinor: FLOAT });
  harness.state.clock = CLOSED_AT;
  return shiftId;
}

function payOut(amountMinor: number): () => unknown {
  return () =>
    harness.service.recordCashMovement({ kind: 'pay_out', amountMinor, reasonCode: 'bank_drop' });
}

function closeWith(countedCashMinor: number): () => unknown {
  return () => harness.service.closeShift({ countedCashMinor });
}

async function probes(): Promise<unknown> {
  return (await harness.service.readStatus()).probeRefusals;
}

describe('readStatus admission: the flag AND the session', () => {
  it.each<[string, (state: ServiceHarness['state']) => void, string]>([
    ['the flag off', (s) => (s.enabled = false), 'feature_disabled'],
    ['no session (or unpaired)', (s) => (s.session = null), 'no_session'],
    ['a locked session', (s) => (s.locked = true), 'session_locked'],
  ])('refuses %s', async (_name, arrange, reason) => {
    arrange(harness.state);
    await expect(harness.service.readStatus()).rejects.toThrow(refusal(reason));
  });

  it('checks the flag before the session, and the session before the lock', async () => {
    harness.state.enabled = false;
    harness.state.session = null;
    await expect(harness.service.readStatus()).rejects.toThrow(refusal('feature_disabled'));
    harness.state.enabled = true;
    harness.state.locked = true;
    await expect(harness.service.readStatus()).rejects.toThrow(refusal('no_session'));
  });

  it('serves a session without a users.id (a manager reads the status too)', async () => {
    harness.state.session = managerSession();
    await expect(harness.service.readStatus()).resolves.toMatchObject({ openShift: null });
  });
});

describe('readStatus re-checks the admitted session after the pairing read (review round 1)', () => {
  type Race = (state: ServiceHarness['state']) => void;

  it.each<[string, Race, string]>([
    ['a sign-out', (s) => (s.session = null), 'no_session'],
    ['a lock', (s) => (s.locked = true), 'session_locked'],
    [
      'a new session of the same cashier',
      (s) => (s.session = { ...cashierSession(), operator_session_id: 'sess-cashier-2' }),
      'no_session',
    ],
    ['another operator signing in', (s) => (s.session = managerSession()), 'no_session'],
    ['a device revocation (no paired scope)', (s) => (s.pairedScope = null), 'no_session'],
    ['a re-pair to another terminal', (s) => (s.pairedScope = { ...OTHER_TERMINAL }), 'no_session'],
    [
      'a re-pair of the session to another terminal',
      (s) => (s.session = cashierSession(OTHER_TERMINAL)),
      'no_session',
    ],
    ['the flag turned off', (s) => (s.enabled = false), 'feature_disabled'],
    // F2 (10944): the re-check re-reads the RT-215 pairing epoch, so a re-pair
    // that keeps the same tenant, branch and terminal id is caught too.
    ['a re-pair of the same terminal (new epoch)', (s) => (s.epoch = 'epoch-2'), 'no_session'],
    ['a revocation latched (no epoch)', (s) => (s.epoch = null), 'no_session'],
  ])('refuses when %s lands during the read', async (_name, race, reason) => {
    harness.state.duringPairedScopeRead = () => {
      race(harness.state);
    };
    await expect(harness.service.readStatus()).rejects.toThrow(refusal(reason));
  });

  it('refuses on a revoked or unpaired terminal (no epoch), with no race', async () => {
    harness.state.epoch = null;
    await expect(harness.service.readStatus()).rejects.toThrow(refusal('no_session'));
  });

  it('refuses a session whose terminal is not the paired one, with no race', async () => {
    harness.state.pairedScope = null;
    await expect(harness.service.readStatus()).rejects.toThrow(refusal('no_session'));
  });

  it('serves the same session when nothing changed during the read', async () => {
    harness.state.duringPairedScopeRead = () => {
      harness.state.session = { ...cashierSession(), operator_session_id: CASHIER_SESSION_ID };
    };
    await expect(harness.service.readStatus()).resolves.toMatchObject({ openShift: null });
  });

  it('the recording calls take no await between admission and the write (synchronous)', () => {
    const opened: unknown = harness.service.openShift({ openingFloatMinor: FLOAT });
    expect(opened).not.toBeInstanceOf(Promise);
    harness.state.clock = CLOSED_AT;
    const moved: unknown = harness.service.recordCashMovement({
      kind: 'pay_in',
      amountMinor: 1,
      reasonCode: 'other',
    });
    expect(moved).not.toBeInstanceOf(Promise);
    const closed: unknown = harness.service.closeShift({ countedCashMinor: FLOAT + 1 });
    expect(closed).not.toBeInstanceOf(Promise);
  });
});

describe('probe refusals (10941 item 3)', () => {
  it('shows none with no shift', async () => {
    await expect(probes()).resolves.toEqual(NO_PROBES);
  });

  it('counts each pay-out refused above the expected drawer cash, on the open shift', async () => {
    openShift();
    expect(payOut(FLOAT + 1)).toThrow(refusal('pay_out_exceeds_drawer_cash'));
    expect(payOut(FLOAT + 2)).toThrow(refusal('pay_out_exceeds_drawer_cash'));
    payOut(FLOAT)();
    await expect(probes()).resolves.toEqual({ payOut: 2, varianceClose: 0, approverFailure: 0 });
  });

  it('counts each close refused for a non-zero variance without an approver', async () => {
    openShift();
    expect(closeWith(FLOAT - 1)).toThrow(refusal('variance_approval_required'));
    expect(closeWith(FLOAT + 1)).toThrow(refusal('variance_approval_required'));
    await expect(probes()).resolves.toEqual({ payOut: 0, varianceClose: 2, approverFailure: 0 });
  });

  it('counts no other refusal (drawer activity in flight, no open shift)', async () => {
    expect(closeWith(FLOAT)).toThrow(expect.objectContaining({ reason: 'shift_not_open' }));
    openShift();
    seedSettlement(db, { saleId: 's-1' });
    expect(payOut(FLOAT + 1)).toThrow(refusal('drawer_activity_pending'));
    expect(closeWith(FLOAT - 1)).toThrow(refusal('drawer_activity_pending'));
    await expect(probes()).resolves.toEqual(NO_PROBES);
  });

  it('starts at zero for the next shift', async () => {
    openShift();
    expect(payOut(FLOAT + 1)).toThrow(refusal('pay_out_exceeds_drawer_cash'));
    seedShiftSale(db, { saleId: 's-1', finalizedAt: OPENED_AT, lines: [cashLine(1_000)] });
    expect(closeWith(FLOAT)).toThrow(refusal('variance_approval_required'));
    closeWith(FLOAT + 1_000)();
    await expect(probes()).resolves.toEqual(NO_PROBES);
    harness.state.clock = msAfter(CLOSED_AT);
    harness.service.openShift({ openingFloatMinor: 0 });
    await expect(probes()).resolves.toEqual(NO_PROBES);
  });
});

describe('pairedShiftScope — the status scope from the pairing', () => {
  it('is the paired terminal’s scope', () => {
    const paired = {
      kind: 'paired',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'term-1',
      terminal_label: 'Till 1',
      paired_at: 1,
    } as const;
    expect(pairedShiftScope(paired)).toEqual({
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      terminalId: 'term-1',
    });
  });

  it.each<PairingStatus>([{ kind: 'unpaired' }, { kind: 'invalid', reason: 'device_revoked' }])(
    'is null when %j',
    (status) => {
      expect(pairedShiftScope(status)).toBeNull();
    },
  );
});
