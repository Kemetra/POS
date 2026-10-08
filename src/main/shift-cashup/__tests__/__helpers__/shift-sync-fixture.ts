/**
 * RT-17 slice 3 part 2 — shared fixture for the shift sync client and engine
 * tests: the facts of one whole shift, recorded through the real repository on
 * the full migration stack (sql.js), and readers for the outbox / state rows.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

import type { QueuedShiftFact, ShiftCashupRepo, ShiftScope } from '../../shift-cashup-repo.js';
import type { CashMovementFact, ShiftCloseFact, ShiftOpenFact } from '../../shift-wire.js';

export const SCOPE: ShiftScope = {
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  terminalId: 'term-1',
};
export const OTHER_TERMINAL: ShiftScope = { ...SCOPE, terminalId: 'term-2' };
export const S1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';
export const S2 = '0192f5a2-3b4c-7d8e-9f01-000000000002';
export const M1 = '0192f5a2-3b4c-7d8e-9f01-0000000000a1';
export const USER = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
export const NOW = '2026-10-05T16:00:01.000Z';

export const OPEN: ShiftOpenFact = {
  shiftId: S1,
  openedAt: '2026-10-05T08:00:00.000Z',
  openingUserId: USER,
  currencyCode: 'EGP',
  openingFloatMinor: 50_000,
};

export const PAY_IN: CashMovementFact = {
  movementId: M1,
  shiftId: S1,
  kind: 'pay_in',
  amountMinor: 1_000,
  reasonCode: 'float_top_up',
  occurredAt: '2026-10-05T09:00:00.000Z',
  operatorUserId: USER,
};

/** Float 500 + sales 100 − refunds 0 + in 10 − out 0 = 610; counted 610. */
export const CLOSE: ShiftCloseFact = {
  shiftId: S1,
  closedAt: '2026-10-05T16:00:00.000Z',
  closingUserId: USER,
  openingFloatMinor: 50_000,
  cashSalesTotalMinor: 10_000,
  cashRefundsTotalMinor: 0,
  payInTotalMinor: 1_000,
  payOutTotalMinor: 0,
  expectedCashMinor: 61_000,
  countedCashMinor: 61_000,
  varianceMinor: 0,
  saleCount: 2,
  cashRefundReturnRefs: [],
};

/** One whole shift on `scope`: open, pay-in, close (in causal order). */
export function recordWholeShift(input: { repo: ShiftCashupRepo; scope?: ShiftScope }): void {
  const scope = input.scope ?? SCOPE;
  input.repo.recordOpen({ scope, fact: OPEN, now: NOW });
  input.repo.recordMovement({ scope, fact: PAY_IN, now: NOW });
  input.repo.recordClose({ scope, fact: CLOSE, now: NOW });
}

/** The queued facts of the whole shift, as the drain would see them (seq 1..3). */
export function wholeShiftFacts(input: { repo: ShiftCashupRepo }): QueuedShiftFact[] {
  recordWholeShift(input);
  return [1, 2, 3].map((seq) => queuedFact({ repo: input.repo, seq }));
}

/** Drain the head with `markSynced` until fact `seq` is due, and return it. */
function queuedFact(input: { repo: ShiftCashupRepo; seq: number }): QueuedShiftFact {
  const next = input.repo.nextFact({ scope: SCOPE, now: NOW });
  if (next.kind !== 'due' || next.fact.seq !== input.seq) {
    throw new Error(`fixture: fact ${String(input.seq)} is not the head`);
  }
  input.repo.markSynced({ seq: input.seq, now: NOW });
  return next.fact;
}

export type Row = Record<string, unknown>;

function rows(input: { db: SqlJsDatabase; sql: string }): Row[] {
  const res = input.db.exec(input.sql)[0];
  if (res === undefined) return [];
  return res.values.map((values) =>
    Object.fromEntries(res.columns.map((column, i) => [column, values[i]])),
  );
}

/** Every state row, by seq. */
export function stateRows(db: SqlJsDatabase): Row[] {
  return rows({
    db,
    sql: `SELECT seq, sync_status, attempt_count, next_retry_at, last_error_category,
            dead_letter_reason FROM shift_sync_state ORDER BY seq`,
  });
}

/** The state row of `seq`. */
export function stateOf(input: { db: SqlJsDatabase; seq: number }): Row {
  const row = stateRows(input.db).find((r) => r['seq'] === input.seq);
  if (row === undefined) throw new Error(`fixture: no state row ${String(input.seq)}`);
  return row;
}
