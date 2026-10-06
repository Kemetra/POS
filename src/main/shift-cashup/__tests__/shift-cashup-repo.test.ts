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

import type { DatabaseHandle } from '../../db/client.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createShiftCashupRepo,
  SHIFT_SYNC_HEAD_SQL,
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

/** The error `run` throws (it must throw). */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error('expected an error');
}

function invalidFactOf(run: () => unknown): { reason: string; field: string } {
  const err = thrown(run);
  if (err instanceof ShiftFactInvalidError) return { reason: err.reason, field: err.field };
  throw err;
}

function stateErrorOf(run: () => unknown): string {
  const err = thrown(run);
  if (err instanceof ShiftCashupStateError) return err.reason;
  throw err;
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

  it.each<{ name: string; change: Partial<ShiftCloseFact>; field: string }>([
    {
      name: 'a pay-out total with no such movement',
      change: { payOutTotalMinor: 3_000, expectedCashMinor: 58_000, varianceMinor: -500 },
      field: 'payOutTotalMinor',
    },
    {
      name: 'a pay-in total other than the movements',
      change: { payInTotalMinor: 2_000, expectedCashMinor: 62_000, varianceMinor: -4_500 },
      field: 'payInTotalMinor',
    },
    {
      name: 'a float other than the open',
      change: { openingFloatMinor: 40_000, expectedCashMinor: 51_000, varianceMinor: 6_500 },
      field: 'openingFloatMinor',
    },
  ])('refuses a close with $name as cashup_inconsistent and writes nothing', (row) => {
    repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
    repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
    const close: ShiftCloseFact = {
      ...CLOSE,
      payOutTotalMinor: 0,
      expectedCashMinor: 61_000,
      varianceMinor: -3_500,
      ...row.change,
    };
    expect(invalidFactOf(() => repo.recordClose({ scope: SCOPE, fact: close, now: NOW }))).toEqual({
      reason: 'cashup_inconsistent',
      field: row.field,
    });
    expect([
      count({ table: 'shift_cashup_closes' }),
      count({ table: 'shift_sync_outbox' }),
    ]).toEqual([0, 2]);
    expect(repo.findOpenShift(SCOPE)).not.toBeNull();
  });

  it('records a close whose expected cash passes 2^53 in the intermediates; SQLite agrees', () => {
    const float = 9_007_199_254_740_987;
    const payOut = 9_007_199_254_740_445;
    repo.recordOpen({ scope: SCOPE, fact: { ...OPEN, openingFloatMinor: float }, now: NOW });
    repo.recordMovement({ scope: SCOPE, fact: { ...PAY_OUT, amountMinor: payOut }, now: NOW });
    repo.recordClose({
      scope: SCOPE,
      fact: {
        ...CLOSE,
        openingFloatMinor: float,
        cashSalesTotalMinor: 9_007_199_254_740_337,
        cashRefundsTotalMinor: 9_007_199_254_740_119,
        payInTotalMinor: 0,
        payOutTotalMinor: payOut,
        expectedCashMinor: 760,
        countedCashMinor: 760,
        varianceMinor: 0,
      },
      now: NOW,
    });
    const stored = db.exec('SELECT expected_cash_minor, variance_minor FROM shift_cashup_closes');
    expect(stored[0]?.values).toEqual([[760, 0]]);
  });
});

/** The handle, failing every INSERT into the outbox (a fault after the fact row is written). */
function outboxFailingHandle(): DatabaseHandle {
  const base = handleFor(db);
  return {
    ...base,
    prepare(sql: string): unknown {
      if (sql.includes('INSERT INTO shift_sync_outbox')) throw new Error('injected outbox fault');
      return base.prepare(sql);
    },
  };
}

function rowCounts(of: { factTable: string }): number[] {
  return [of.factTable, 'shift_sync_outbox', 'shift_sync_state'].map((table) => count({ table }));
}

describe('atomicity: a fault after the fact row is written persists nothing', () => {
  it.each<{
    name: string;
    table: string;
    arrange: () => void;
    record: (r: ShiftCashupRepo) => void;
  }>([
    {
      name: 'an open',
      table: 'shift_cashup_opens',
      arrange: () => undefined,
      record: (r) => r.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW }),
    },
    {
      name: 'a movement',
      table: 'shift_cashup_movements',
      arrange: () => repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW }),
      record: (r) => r.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW }),
    },
    {
      name: 'a close',
      table: 'shift_cashup_closes',
      arrange: () => {
        repo.recordOpen({ scope: SCOPE, fact: OPEN, now: NOW });
        repo.recordMovement({ scope: SCOPE, fact: PAY_IN, now: NOW });
        repo.recordMovement({ scope: SCOPE, fact: PAY_OUT, now: NOW });
      },
      record: (r) => r.recordClose({ scope: SCOPE, fact: CLOSE, now: NOW }),
    },
  ])('$name', (row) => {
    row.arrange();
    const before = rowCounts({ factTable: row.table });
    expect(() => {
      row.record(createShiftCashupRepo(outboxFailingHandle()));
    }).toThrow(/injected outbox fault/);
    expect(rowCounts({ factTable: row.table })).toEqual(before);
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

  it('compares retry instants as instants, not as strings', () => {
    recordWholeShift();
    const farFuture = '+010000-01-01T00:00:00.000Z';
    repo.recordRetry({ seq: 1, now: NOW, nextRetryAt: farFuture, category: 'transient' });
    expect(repo.nextFact({ scope: SCOPE, now: NOW })).toEqual({
      kind: 'waiting',
      seq: 1,
      nextRetryAt: farFuture,
    });
  });

  it('looks the head up through the index of unsettled state rows only', () => {
    const plan = db.exec(`EXPLAIN QUERY PLAN ${SHIFT_SYNC_HEAD_SQL}`, ['t', 'b', 'term'])[0];
    const steps = (plan?.values ?? []).map((row) => String(row[3]));
    expect(steps[0]).toMatch(/^SCAN s USING INDEX idx_shift_sync_state_unsettled/);
  });

  it('refuses a non-canonical now', () => {
    recordWholeShift();
    expect(
      invalidFactOf(() => repo.nextFact({ scope: SCOPE, now: '2026-10-05 08:00:00' })),
    ).toEqual({ reason: 'invalid_timestamp', field: 'now' });
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

  it.each<{ name: string; field: string; transition: (r: ShiftCashupRepo) => boolean }>([
    {
      name: 'recordRetry with a non-canonical nextRetryAt',
      field: 'nextRetryAt',
      transition: (r) =>
        r.recordRetry({
          seq: 1,
          now: NOW,
          nextRetryAt: '2026-10-05T08:00:03Z',
          category: 'transient',
        }),
    },
    {
      name: 'recordRetry with a non-canonical now',
      field: 'now',
      transition: (r) =>
        r.recordRetry({ seq: 1, now: 'now', nextRetryAt: NOW, category: 'transient' }),
    },
    {
      name: 'markSynced with a non-canonical now',
      field: 'now',
      transition: (r) => r.markSynced({ seq: 1, now: '2026-10-05' }),
    },
    {
      name: 'markDeadLetter with a non-canonical now',
      field: 'now',
      transition: (r) =>
        r.markDeadLetter({ seq: 1, now: '2026-10-05T08:00:01+00:00', reason: 'rejected' }),
    },
  ])('refuses $name and changes nothing', ({ field, transition }) => {
    const before = stateOf({ seq: 1 });
    expect(invalidFactOf(() => transition(repo))).toEqual({ reason: 'invalid_timestamp', field });
    expect(stateOf({ seq: 1 })).toEqual(before);
  });
});

describe('envelope repair of a dead-lettered fact', () => {
  const T_REPAIR = '2026-10-05T18:00:00.000Z';

  /** A whole shift with the open synced and the pay-in (seq 2) dead-lettered. */
  function deadLetterPayIn(): void {
    recordWholeShift();
    repo.markSynced({ seq: 1, now: NOW });
    repo.markDeadLetter({ seq: 2, now: NOW, reason: 'cashier_claim_refused' });
  }

  function drainAll(): number[] {
    const order: number[] = [];
    for (;;) {
      const next = repo.nextFact({ scope: SCOPE, now: T_REPAIR });
      if (next.kind !== 'due') return order;
      order.push(next.fact.seq);
      repo.markSynced({ seq: next.fact.seq, now: T_REPAIR });
    }
  }

  it('supersedes the dead letter with an envelope row that drains in its causal place', () => {
    deadLetterPayIn();
    expect(repo.nextFact({ scope: SCOPE, now: T_REPAIR }).kind).toBe('blocked');

    const repaired = repo.recordEnvelopeRepair({ seq: 2, now: T_REPAIR });
    expect(repaired).toEqual({ seq: 5, idempotencyKey: `pos-pulse-shift-movement:${M1}:repair-2` });
    expect(stateOf({ seq: 2 })).toMatchObject({
      sync_status: 'superseded',
      superseded_by_seq: 5,
      resolved_at: T_REPAIR,
      dead_letter_reason: 'cashier_claim_refused',
    });

    const deviceBody = JSON.parse(String(outboxRow({ seq: 2 })['request_body'])) as Record<
      string,
      unknown
    >;
    delete deviceBody['operatorUserId'];
    const head = repo.nextFact({ scope: SCOPE, now: T_REPAIR });
    expect(head).toEqual({
      kind: 'due',
      fact: {
        seq: 5,
        factKind: 'movement',
        shiftId: S1,
        authPath: 'envelope',
        idempotencyKey: `pos-pulse-shift-movement:${M1}:repair-2`,
        requestBody: JSON.stringify(deviceBody),
        attemptCount: 0,
      },
    });
    expect(drainAll()).toEqual([5, 3, 4]);
    expect(repo.nextFact({ scope: SCOPE, now: T_REPAIR })).toEqual({ kind: 'idle' });
  });

  it('repairs a failed repair again, still ahead of the later facts', () => {
    deadLetterPayIn();
    repo.recordEnvelopeRepair({ seq: 2, now: T_REPAIR });
    repo.markDeadLetter({ seq: 5, now: T_REPAIR, reason: 'rejected' });
    expect(repo.nextFact({ scope: SCOPE, now: T_REPAIR })).toMatchObject({
      kind: 'blocked',
      seq: 5,
    });
    expect(repo.recordEnvelopeRepair({ seq: 5, now: T_REPAIR })).toEqual({
      seq: 6,
      idempotencyKey: `pos-pulse-shift-movement:${M1}:repair-5`,
    });
    expect(drainAll()).toEqual([6, 3, 4]);
  });

  it('repairs a dead-lettered open ahead of every later fact of the shift', () => {
    recordWholeShift();
    repo.markDeadLetter({ seq: 1, now: NOW, reason: 'cashier_claim_refused' });
    repo.recordEnvelopeRepair({ seq: 1, now: T_REPAIR });
    expect(drainAll()).toEqual([5, 2, 3, 4]);
  });

  it.each<{ name: string; seq: number; supersedeFirst: boolean }>([
    { name: 'a pending row', seq: 3, supersedeFirst: false },
    { name: 'a synced row', seq: 1, supersedeFirst: false },
    { name: 'a superseded row', seq: 2, supersedeFirst: true },
    { name: 'an unknown seq', seq: 99, supersedeFirst: false },
  ])('refuses to repair $name and writes nothing', ({ seq, supersedeFirst }) => {
    deadLetterPayIn();
    if (supersedeFirst) repo.recordEnvelopeRepair({ seq: 2, now: T_REPAIR });
    const before = count({ table: 'shift_sync_outbox' });
    expect(stateErrorOf(() => repo.recordEnvelopeRepair({ seq, now: T_REPAIR }))).toBe(
      'not_dead_lettered',
    );
    expect(count({ table: 'shift_sync_outbox' })).toBe(before);
  });

  it('refuses a non-canonical now', () => {
    deadLetterPayIn();
    expect(invalidFactOf(() => repo.recordEnvelopeRepair({ seq: 2, now: 'later' }))).toEqual({
      reason: 'invalid_timestamp',
      field: 'now',
    });
    expect(stateOf({ seq: 2 })['sync_status']).toBe('dead_letter');
  });
});
