/**
 * RT-17 slice 3 — `shift-cashup-repo`: the local cash-up facts and the shift
 * outbox (migration 0043).
 *
 *   • Recording a fact writes the immutable fact, its outbox row (the exact
 *     body and Idempotency-Key, decided now) and its pending state row in ONE
 *     transaction; a refused fact writes nothing.
 *   • One open shift per terminal; movements and the close only on the
 *     terminal's open shift; the shift's own currency renders the amounts.
 *   • The drain reads ONE fact at a time, strictly in causal order (`seq`): the
 *     head of this terminal's unsynced facts. A head in backoff is `waiting`; a
 *     dead-lettered head `blocks` every later fact (they would otherwise reach
 *     Backend-Core out of order).
 *   • Sync transitions apply only to a pending row.
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
  ShiftCashupStateError,
  type ShiftCashupRepo,
  type ShiftScope,
} from '../shift-cashup-repo.js';
import {
  ShiftFactInvalidError,
  type CashMovementFact,
  type ShiftCloseFact,
  type ShiftOpenFact,
} from '../shift-wire.js';

const SCOPE: ShiftScope = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'term-1' };
const OTHER_TERMINAL: ShiftScope = { ...SCOPE, terminalId: 'term-2' };
const S1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';
const S2 = '0192f5a2-3b4c-7d8e-9f01-000000000002';
const M1 = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
const M2 = '0192f5a2-3b4c-7d8e-9f01-0000000000a2';
const USER = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const NOW = '2026-10-05T08:00:01.000Z';

const OPEN: ShiftOpenFact = {
  shiftId: S1,
  openedAt: '2026-10-05T08:00:00.000Z',
  openingUserId: USER,
  currencyCode: 'EGP',
  openingFloatMinor: 50_000,
};

const PAY_IN: CashMovementFact = {
  movementId: M1,
  shiftId: S1,
  kind: 'pay_in',
  amountMinor: 1_000,
  reasonCode: 'float_top_up',
  occurredAt: '2026-10-05T09:00:00.000Z',
  operatorUserId: USER,
};

const PAY_OUT: CashMovementFact = {
  ...PAY_IN,
  movementId: M2,
  kind: 'pay_out',
  amountMinor: 3_000,
  reasonCode: 'bank_drop',
};

/** Float 500 + sales 100 − refunds 0 + in 10 − out 30 = 580; counted 575. */
const CLOSE: ShiftCloseFact = {
  shiftId: S1,
  closedAt: '2026-10-05T16:00:00.000Z',
  closingUserId: USER,
  openingFloatMinor: 50_000,
  cashSalesTotalMinor: 10_000,
  cashRefundsTotalMinor: 0,
  payInTotalMinor: 1_000,
  payOutTotalMinor: 3_000,
  expectedCashMinor: 58_000,
  countedCashMinor: 57_500,
  varianceMinor: -500,
  saleCount: 2,
  cashRefundReturnRefs: [],
};

interface SeqRef {
  seq: number;
}

let db: SqlJsDatabase;
let repo: ShiftCashupRepo;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  repo = createShiftCashupRepo(handleFor(db));
});

afterEach(() => {
  db.close();
});

function count(of: { table: string }): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${of.table}`)[0]?.values[0]?.[0] ?? -1);
}

function outboxRow({ seq }: SeqRef): Record<string, unknown> {
  const res = db.exec(
    `SELECT o.*, s.sync_status, s.attempt_count FROM shift_sync_outbox o
     JOIN shift_sync_state s ON s.seq = o.seq WHERE o.seq = ${String(seq)}`,
  )[0];
  if (res === undefined) throw new Error(`no outbox row ${String(seq)}`);
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

function stateOf({ seq }: SeqRef): Record<string, unknown> {
  const res = db.exec(`SELECT * FROM shift_sync_state WHERE seq = ${String(seq)}`)[0];
  if (res === undefined) throw new Error(`no state row ${String(seq)}`);
  return Object.fromEntries(res.columns.map((c, i) => [c, res.values[0]?.[i]]));
}

/** A whole shift: open, pay-in, pay-out, close (seq 1..4). */
function recordWholeShift(): void {
  repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
  repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
  repo.recordMovement({ scope: SCOPE, fact: PAY_OUT, now: NOW });
  repo.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW });
}

function stateErrorOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof ShiftCashupStateError) return err.reason;
    throw err;
  }
  throw new Error('expected a ShiftCashupStateError');
}

describe('recording facts', () => {
  it('records an open with its exact bytes, key and a pending state row, atomically', () => {
    const recorded = repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    expect(recorded).toEqual({ seq: 1, idempotencyKey: `pos-pulse-shift-open:${S1}` });
    expect(outboxRow({ seq: 1 })).toMatchObject({
      fact_kind: 'open',
      shift_id: S1,
      movement_id: null,
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'term-1',
      auth_path: 'device',
      idempotency_key: `pos-pulse-shift-open:${S1}`,
      request_body: JSON.stringify({
        shiftId: S1,
        openedAt: OPEN.openedAt,
        openingUserId: USER,
        currencyCode: 'EGP',
        openingFloat: '500.00',
        operatorUserId: USER,
      }),
      enqueued_at: NOW,
      sync_status: 'pending',
      attempt_count: 0,
    });
    expect(count({ table: 'shift_cashup_opens' })).toBe(1);
  });

  it('stores lower-case ids for an upper-case fact', () => {
    repo.recordOpen({
      scope: SCOPE,
      fact: { ...OPEN, shiftId: S1.toUpperCase(), openingUserId: USER.toUpperCase() },
      now: NOW,
    });
    repo.recordMovement({ scope: SCOPE, fact: { ...PAY_IN, shiftId: S1.toUpperCase() }, now: NOW });
    expect(repo.findOpenShift(SCOPE)).toMatchObject({ shiftId: S1, openingUserId: USER });
    expect(outboxRow({ seq: 2 })).toMatchObject({ shift_id: S1, movement_id: M1 });
  });

  it('refuses a second open on the terminal and writes nothing', () => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    expect(
      stateErrorOf(() =>
        repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, shiftId: S2 }, now: NOW }),
      ),
    ).toBe('shift_already_open');
    expect([count({ table: 'shift_cashup_opens' }), count({ table: 'shift_sync_outbox' })]).toEqual(
      [1, 1],
    );
  });

  it('refuses an invalid fact before writing anything', () => {
    expect(() =>
      repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, openingFloatMinor: 1.5 }, now: NOW }),
    ).toThrow(ShiftFactInvalidError);
    expect([count({ table: 'shift_cashup_opens' }), count({ table: 'shift_sync_outbox' })]).toEqual(
      [0, 0],
    );
  });

  it('renders a movement in the shift currency', () => {
    repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, currencyCode: 'JPY' }, now: NOW });
    repo.recordMovement({ scope: SCOPE, fact: { ...PAY_IN, amountMinor: 500 }, now: NOW });
    expect(JSON.parse(String(outboxRow({ seq: 2 })['request_body']))).toMatchObject({
      amount: '500',
    });
    expect(outboxRow({ seq: 2 })['idempotency_key']).toBe(`pos-pulse-shift-movement:${M1}`);
  });

  it.each<{ name: string; arrange: () => void }>([
    { name: 'no shift', arrange: () => undefined },
    {
      name: 'a closed shift',
      arrange: () => {
        repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
        repo.recordClose({
          scope: SCOPE,
          fact: {
            ...CLOSE,
            payInTotalMinor: 0,
            payOutTotalMinor: 0,
            expectedCashMinor: 60_000,
            varianceMinor: -2_500,
          },
          now: NOW,
        });
      },
    },
    {
      name: "another terminal's shift",
      arrange: () => {
        repo.recordOpen({ scope: OTHER_TERMINAL, fact: OPEN, now: NOW });
      },
    },
  ])('refuses a movement on $name', ({ arrange }) => {
    arrange();
    const before = count({ table: 'shift_sync_outbox' });
    expect(stateErrorOf(() => repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW }))).toBe(
      'shift_not_open',
    );
    expect(count({ table: 'shift_sync_outbox' })).toBe(before);
  });

  it('records a close and its outbox row; the terminal then has no open shift', () => {
    recordWholeShift();
    expect(outboxRow({ seq: 4 })).toMatchObject({
      fact_kind: 'close',
      idempotency_key: `pos-pulse-shift-close:${S1}`,
      auth_path: 'device',
    });
    expect(JSON.parse(String(outboxRow({ seq: 4 })['request_body']))).toMatchObject({
      expectedCash: '580.00',
      variance: '-5.00',
      operatorUserId: USER,
    });
    expect(repo.findOpenShift(SCOPE)).toBeNull();
    expect(stateErrorOf(() => repo.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW }))).toBe(
      'shift_not_open',
    );
  });

  it('writes nothing when the close totals disagree with the recorded movements', () => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
    expect(() => repo.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW })).toThrow(
      /movement totals/,
    );
    expect([
      count({ table: 'shift_cashup_closes' }),
      count({ table: 'shift_sync_outbox' }),
    ]).toEqual([0, 2]);
    expect(repo.findOpenShift(SCOPE)).not.toBeNull();
  });
});

describe('findOpenShift', () => {
  it('is null with no shift, and for another terminal', () => {
    expect(repo.findOpenShift(SCOPE)).toBeNull();
    repo.recordOpen({ scope: OTHER_TERMINAL, fact: OPEN, now: NOW });
    expect(repo.findOpenShift(SCOPE)).toBeNull();
  });

  it('returns the open shift with its float and movement totals', () => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
    repo.recordMovement({ scope: SCOPE, fact: PAY_OUT, now: NOW });
    expect(repo.findOpenShift(SCOPE)).toEqual({
      shiftId: S1,
      openedAt: OPEN.openedAt,
      openingUserId: USER,
      currencyCode: 'EGP',
      openingFloatMinor: 50_000,
      payInTotalMinor: 1_000,
      payOutTotalMinor: 3_000,
    });
  });
});

describe('the drain read: one fact at a time, in causal order', () => {
  const T_LATER = '2026-10-05T08:10:00.000Z';

  it('is idle with nothing queued, or with no current pairing', () => {
    expect(repo.nextFact({ scope: SCOPE, now: NOW })).toEqual({ kind: 'idle' });
    recordWholeShift();
    expect(repo.nextFact({ scope: { ...SCOPE, terminalId: null }, now: NOW })).toEqual({
      kind: 'idle',
    });
    expect(repo.nextFact({ scope: OTHER_TERMINAL, now: NOW })).toEqual({ kind: 'idle' });
  });

  it('walks open → movements → close as each is synced', () => {
    recordWholeShift();
    const kinds: string[] = [];
    for (;;) {
      const next = repo.nextFact({ scope: SCOPE, now: NOW });
      if (next.kind !== 'due') break;
      kinds.push(next.fact.factKind);
      expect(repo.markSynced({ seq: next.fact.seq, now: NOW })).toBe(true);
    }
    expect(kinds).toEqual(['open', 'movement', 'movement', 'close']);
    expect(repo.nextFact({ scope: SCOPE, now: NOW })).toEqual({ kind: 'idle' });
  });

  it('returns the stored bytes, key, path inputs and attempt count of the head', () => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    const next = repo.nextFact({ scope: SCOPE, now: NOW });
    expect(next).toEqual({
      kind: 'due',
      fact: {
        seq: 1,
        factKind: 'open',
        shiftId: S1,
        authPath: 'device',
        idempotencyKey: `pos-pulse-shift-open:${S1}`,
        requestBody: String(outboxRow({ seq: 1 })['request_body']),
        attemptCount: 0,
      },
    });
  });

  it('waits on a head in backoff — the later facts are not offered', () => {
    recordWholeShift();
    expect(
      repo.recordRetry({ seq: 1, now: NOW, nextRetryAt: T_LATER, category: 'no_connection' }),
    ).toBe(true);
    expect(repo.nextFact({ scope: SCOPE, now: NOW })).toEqual({
      kind: 'waiting',
      seq: 1,
      nextRetryAt: T_LATER,
    });
    const due = repo.nextFact({ scope: SCOPE, now: T_LATER });
    expect(due.kind === 'due' && due.fact).toMatchObject({ seq: 1, attemptCount: 1 });
  });

  it('is blocked by a dead-lettered head — nothing after it is offered', () => {
    recordWholeShift();
    repo.markSynced({ seq: 1, now: NOW });
    expect(repo.markDeadLetter({ seq: 2, now: NOW, reason: 'cashier_claim_refused' })).toBe(true);
    expect(repo.nextFact({ scope: SCOPE, now: T_LATER })).toEqual({
      kind: 'blocked',
      seq: 2,
      reason: 'cashier_claim_refused',
    });
  });

  it("orders by seq across shifts: shift 2's open waits for shift 1's close", () => {
    recordWholeShift();
    repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, shiftId: S2 }, now: NOW });
    for (const seq of [1, 2, 3]) repo.markSynced({ seq, now: NOW });
    const next = repo.nextFact({ scope: SCOPE, now: NOW });
    expect(next.kind === 'due' && next.fact).toMatchObject({ seq: 4, factKind: 'close' });
  });
});

describe('sync transitions', () => {
  beforeEach(() => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
  });

  it('recordRetry counts the attempt and stores the category and the next retry', () => {
    repo.recordRetry({
      seq: 1,
      now: NOW,
      nextRetryAt: '2026-10-05T08:00:03.000Z',
      category: 'transient',
    });
    expect(stateOf({ seq: 1 })).toMatchObject({
      sync_status: 'pending',
      attempt_count: 1,
      next_retry_at: '2026-10-05T08:00:03.000Z',
      last_error_category: 'transient',
      last_attempt_at: NOW,
    });
  });

  it('markDeadLetter counts the attempt and keeps the reason', () => {
    repo.markDeadLetter({ seq: 1, now: NOW, reason: 'shift_payload_conflict' });
    expect(stateOf({ seq: 1 })).toMatchObject({
      sync_status: 'dead_letter',
      attempt_count: 1,
      dead_letter_reason: 'shift_payload_conflict',
      next_retry_at: null,
    });
  });

  it('markSynced counts the attempt and stamps synced_at', () => {
    repo.markSynced({ seq: 1, now: NOW });
    expect(stateOf({ seq: 1 })).toMatchObject({
      sync_status: 'synced',
      attempt_count: 1,
      synced_at: NOW,
      next_retry_at: null,
      last_error_category: null,
    });
  });

  it.each<{ name: string; transition: (r: ShiftCashupRepo) => boolean }>([
    { name: 'markSynced', transition: (r) => r.markSynced({ seq: 1, now: NOW }) },
    {
      name: 'markDeadLetter',
      transition: (r) => r.markDeadLetter({ seq: 1, now: NOW, reason: 'shift_closed' }),
    },
    {
      name: 'recordRetry',
      transition: (r) =>
        r.recordRetry({ seq: 1, now: NOW, nextRetryAt: NOW, category: 'transient' }),
    },
  ])('$name changes nothing on a row that is no longer pending', ({ transition }) => {
    repo.markSynced({ seq: 1, now: NOW });
    const before = stateOf({ seq: 1 });
    expect(transition(repo)).toBe(false);
    expect(stateOf({ seq: 1 })).toEqual(before);
  });

  it('a transition on an unknown seq applies nothing', () => {
    expect(repo.markSynced({ seq: 99, now: NOW })).toBe(false);
  });
});
