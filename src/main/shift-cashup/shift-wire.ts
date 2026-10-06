/**
 * RT-17 slice 3 — the shift cash-up wire bodies.
 *
 * A cash-up fact (Jira RT-17 comment 10919) is recorded locally in integer minor
 * units and sent to Backend-Core `pos-shifts.openapi.yaml` 1.1.0-draft
 * (Backend-Core `8d9ba99`). These pure builders decide, ONCE, the exact bytes a
 * fact is sent with: the JSON body and the Idempotency-Key. The repository
 * stores both with the fact in one transaction, and the drain re-sends exactly
 * those stored bytes on every retry; nothing here runs again for a queued fact
 * (RT-17 10931/10934, as RT-225 did with `admissionCheckAt`).
 *
 * Rules applied:
 *   • every id is sent and kept in lower case (10934); it must be an
 *     8-4-4-4-12 hex UUID;
 *   • every amount is an exact-decimal string with exactly the shift
 *     currency's ISO-4217 minor-unit digits (`minorUnitsToDecimalString`, pure
 *     integer math, never a float), within the contract's 15 integer digits; a
 *     currency the POS has no exponent for is refused, never assumed 2;
 *   • every instant is the canonical `Date#toISOString()` form;
 *   • the body is the DEVICE path's (RT-224): it always carries
 *     `operatorUserId`, the fact's own actor — the opening user on an open, the
 *     movement's operator, the closing user on a close (the contract requires
 *     `openingUserId` / `closingUserId` to equal it on that path). A close built
 *     here is always `closeKind: normal`; a forced close is manager-envelope
 *     only and is not built by the POS in this slice;
 *   • the close arithmetic is checked as Backend-Core checks it on ingest:
 *     expected = float + cash sales − cash refunds + pay-in − pay-out,
 *     variance = counted − expected, and expected / counted are never negative.
 *     Each amount is a safe integer, but a partial sum may not be, so the
 *     check runs in `bigint` (exact, as SQLite's 64-bit integers are).
 *
 * A dead-lettered fact is repaired on the manager-envelope path
 * (`buildEnvelopeRepairRequest`): the SAME stored body less `operatorUserId`
 * (the claim is not part of the natural-key payload hash, so the server sees
 * the same fact) under a new Idempotency-Key of its own.
 *
 * A refused fact throws `ShiftFactInvalidError` naming the field and a closed
 * reason — never the value (P7).
 */
import {
  knownExponentFor,
  minorUnitsToDecimalString,
} from '../sales-sync/create-sale-sync-client.js';

export type ShiftFactKind = 'open' | 'movement' | 'close';

export const CASH_MOVEMENT_KINDS = ['pay_in', 'pay_out'] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export const CASH_MOVEMENT_REASON_CODES = [
  'bank_drop',
  'float_top_up',
  'petty_expense',
  'other',
] as const;
export type CashMovementReasonCode = (typeof CASH_MOVEMENT_REASON_CODES)[number];

/** `ShiftOpened`: a shift opened on this terminal with its float. */
export interface ShiftOpenFact {
  shiftId: string;
  openedAt: string;
  openingUserId: string;
  currencyCode: string;
  openingFloatMinor: number;
}

/** `CashMovement`: a pay-in or pay-out on an open shift. */
export interface CashMovementFact {
  movementId: string;
  shiftId: string;
  kind: CashMovementKind;
  amountMinor: number;
  reasonCode: CashMovementReasonCode;
  /** Optional, 1–200 characters, no PII (the contract's rule). */
  note?: string;
  occurredAt: string;
  operatorUserId: string;
}

/** `ShiftClosed`: the cashier's (normal) cash-up of the shift. */
export interface ShiftCloseFact {
  shiftId: string;
  closedAt: string;
  closingUserId: string;
  openingFloatMinor: number;
  cashSalesTotalMinor: number;
  cashRefundsTotalMinor: number;
  payInTotalMinor: number;
  payOutTotalMinor: number;
  expectedCashMinor: number;
  countedCashMinor: number;
  varianceMinor: number;
  saleCount: number;
  /** Backend-Core return references (UUIDs) of the cash refunds paid from this drawer. */
  cashRefundReturnRefs: readonly string[];
  /** The manager who approved a non-zero variance on the terminal. */
  varianceApprovedByUserId?: string;
}

/** The exact request a fact is sent with, decided once. */
export interface ShiftWireRequest {
  idempotencyKey: string;
  /** The JSON body, byte for byte. */
  body: string;
}

/** A fact normalised for storage (lower-case ids) and its request. */
export interface BuiltShiftFact<F> {
  fact: F;
  request: ShiftWireRequest;
}

/** A movement or close is rendered in its shift's currency. */
export interface InShiftCurrency<F> {
  fact: F;
  currencyCode: string;
}

export type ShiftFactInvalidReason =
  | 'invalid_id'
  | 'invalid_timestamp'
  | 'unsupported_currency'
  | 'invalid_amount'
  | 'invalid_kind'
  | 'invalid_reason_code'
  | 'invalid_note'
  | 'invalid_sale_count'
  | 'invalid_refund_refs'
  | 'cashup_inconsistent';

export interface ShiftFactProblem {
  reason: ShiftFactInvalidReason;
  field: string;
}

/** A fact the POS refuses to record. Names the field, never its value. */
export class ShiftFactInvalidError extends Error {
  readonly reason: ShiftFactInvalidReason;
  readonly field: string;

  constructor(problem: ShiftFactProblem) {
    super(`shift cash-up fact refused: ${problem.field} (${problem.reason})`);
    this.name = 'ShiftFactInvalidError';
    this.reason = problem.reason;
    this.field = problem.field;
  }
}

const IDEMPOTENCY_KEY_PREFIX: Readonly<Record<ShiftFactKind, string>> = {
  open: 'pos-pulse-shift-open:',
  movement: 'pos-pulse-shift-movement:',
  close: 'pos-pulse-shift-close:',
};

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
/** The contract's decimal grammar (`SignedDecimalAmount` ⊇ `NonNegativeDecimalAmount`). */
const DECIMAL_AMOUNT = /^-?[0-9]{1,15}(\.[0-9]{1,4})?$/;
const NOTE_MAX = 200;
const SALE_COUNT_MAX = 2_147_483_647;
const REFUND_REFS_MAX = 1_000;

export interface Field<T> {
  readonly field: string;
  readonly value: T;
}

type AmountSign = 'non_negative' | 'positive' | 'signed';

interface AmountField {
  readonly field: string;
  readonly minor: number;
  readonly exponent: number;
  readonly sign: AmountSign;
}

const AMOUNT_MIN: Readonly<Record<AmountSign, number>> = {
  non_negative: 0,
  positive: 1,
  signed: Number.MIN_SAFE_INTEGER,
};

function refuse(problem: ShiftFactProblem): never {
  throw new ShiftFactInvalidError(problem);
}

function lowerUuid(id: Field<string>): string {
  const lower = id.value.toLowerCase();
  if (!UUID_LOWER.test(lower)) refuse({ reason: 'invalid_id', field: id.field });
  return lower;
}

/** A canonical `Date#toISOString()` instant, else `invalid_timestamp` naming the field. */
export function isoInstant(at: Field<string>): string {
  const ms = Date.parse(at.value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== at.value) {
    refuse({ reason: 'invalid_timestamp', field: at.field });
  }
  return at.value;
}

function currencyExponent(code: Field<string>): number {
  const exponent = CURRENCY_CODE.test(code.value) ? knownExponentFor(code.value) : undefined;
  if (exponent === undefined) refuse({ reason: 'unsupported_currency', field: code.field });
  return exponent;
}

function decimal(amount: AmountField): string {
  if (!Number.isSafeInteger(amount.minor) || amount.minor < AMOUNT_MIN[amount.sign]) {
    refuse({ reason: 'invalid_amount', field: amount.field });
  }
  const text = minorUnitsToDecimalString(amount.minor, amount.exponent);
  if (!DECIMAL_AMOUNT.test(text)) refuse({ reason: 'invalid_amount', field: amount.field });
  return text;
}

interface Choice<T extends string> extends Field<string> {
  readonly allowed: readonly T[];
  readonly reason: ShiftFactInvalidReason;
}

function oneOf<T extends string>(choice: Choice<T>): T {
  const found = choice.allowed.find((option) => option === choice.value);
  return found ?? refuse({ reason: choice.reason, field: choice.field });
}

function noteOf(fact: CashMovementFact): { note?: string } {
  if (fact.note === undefined) return {};
  if (fact.note.length < 1 || fact.note.length > NOTE_MAX) {
    refuse({ reason: 'invalid_note', field: 'note' });
  }
  return { note: fact.note };
}

function request(key: { kind: ShiftFactKind; id: string }, body: object): ShiftWireRequest {
  return {
    idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX[key.kind]}${key.id}`,
    body: JSON.stringify(body),
  };
}

/** The `openShift` body and key (device path: `operatorUserId` = the opening user). */
export function buildOpenShiftRequest(input: ShiftOpenFact): BuiltShiftFact<ShiftOpenFact> {
  const exponent = currencyExponent({ field: 'currencyCode', value: input.currencyCode });
  const fact: ShiftOpenFact = {
    shiftId: lowerUuid({ field: 'shiftId', value: input.shiftId }),
    openedAt: isoInstant({ field: 'openedAt', value: input.openedAt }),
    openingUserId: lowerUuid({ field: 'openingUserId', value: input.openingUserId }),
    currencyCode: input.currencyCode,
    openingFloatMinor: input.openingFloatMinor,
  };
  const openingFloat = decimal({
    field: 'openingFloatMinor',
    minor: fact.openingFloatMinor,
    exponent,
    sign: 'non_negative',
  });
  const body = {
    shiftId: fact.shiftId,
    openedAt: fact.openedAt,
    openingUserId: fact.openingUserId,
    currencyCode: fact.currencyCode,
    openingFloat,
    operatorUserId: fact.openingUserId,
  };
  return { fact, request: request({ kind: 'open', id: fact.shiftId }, body) };
}

/** The `recordCashMovement` body and key, in the shift's currency. */
export function buildCashMovementRequest(
  input: InShiftCurrency<CashMovementFact>,
): BuiltShiftFact<CashMovementFact> {
  const exponent = currencyExponent({ field: 'currencyCode', value: input.currencyCode });
  const given = input.fact;
  const fact: CashMovementFact = {
    movementId: lowerUuid({ field: 'movementId', value: given.movementId }),
    shiftId: lowerUuid({ field: 'shiftId', value: given.shiftId }),
    kind: oneOf({
      field: 'kind',
      value: given.kind,
      allowed: CASH_MOVEMENT_KINDS,
      reason: 'invalid_kind',
    }),
    amountMinor: given.amountMinor,
    reasonCode: oneOf({
      field: 'reasonCode',
      value: given.reasonCode,
      allowed: CASH_MOVEMENT_REASON_CODES,
      reason: 'invalid_reason_code',
    }),
    ...noteOf(given),
    occurredAt: isoInstant({ field: 'occurredAt', value: given.occurredAt }),
    operatorUserId: lowerUuid({ field: 'operatorUserId', value: given.operatorUserId }),
  };
  const amount = decimal({
    field: 'amountMinor',
    minor: fact.amountMinor,
    exponent,
    sign: 'positive',
  });
  const body = {
    movementId: fact.movementId,
    kind: fact.kind,
    amount,
    reasonCode: fact.reasonCode,
    ...noteOf(fact),
    occurredAt: fact.occurredAt,
    operatorUserId: fact.operatorUserId,
  };
  return { fact, request: request({ kind: 'movement', id: fact.movementId }, body) };
}

/** The close's amounts, in wire order: [fact field, wire key, sign]. */
const CLOSE_AMOUNTS = [
  ['openingFloatMinor', 'openingFloat', 'non_negative'],
  ['cashSalesTotalMinor', 'cashSalesTotal', 'non_negative'],
  ['cashRefundsTotalMinor', 'cashRefundsTotal', 'non_negative'],
  ['payInTotalMinor', 'payInTotal', 'non_negative'],
  ['payOutTotalMinor', 'payOutTotal', 'non_negative'],
  ['expectedCashMinor', 'expectedCash', 'non_negative'],
  ['countedCashMinor', 'countedCash', 'non_negative'],
  ['varianceMinor', 'variance', 'signed'],
] as const satisfies ReadonlyArray<readonly [keyof ShiftCloseFact, string, AmountSign]>;

function closeAmounts(input: InShiftCurrency<ShiftCloseFact>): Record<string, string> {
  const exponent = currencyExponent({ field: 'currencyCode', value: input.currencyCode });
  return Object.fromEntries(
    CLOSE_AMOUNTS.map(([field, wireKey, sign]) => [
      wireKey,
      decimal({ field, minor: input.fact[field], exponent, sign }),
    ]),
  );
}

/**
 * Backend-Core's ingest invariant (422 `shift_cashup_inconsistent` otherwise),
 * in `bigint`: every amount is already a checked safe integer, but
 * float + sales alone can pass 2^53, where `number` arithmetic rounds.
 */
function checkArithmetic(fact: ShiftCloseFact): void {
  const expected =
    BigInt(fact.openingFloatMinor) +
    BigInt(fact.cashSalesTotalMinor) -
    BigInt(fact.cashRefundsTotalMinor) +
    BigInt(fact.payInTotalMinor) -
    BigInt(fact.payOutTotalMinor);
  if (expected !== BigInt(fact.expectedCashMinor)) {
    refuse({ reason: 'cashup_inconsistent', field: 'expectedCashMinor' });
  }
  const variance = BigInt(fact.countedCashMinor) - BigInt(fact.expectedCashMinor);
  if (variance !== BigInt(fact.varianceMinor)) {
    refuse({ reason: 'cashup_inconsistent', field: 'varianceMinor' });
  }
}

function isIntInRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

function saleCountOf(fact: ShiftCloseFact): number {
  const count = fact.saleCount;
  if (!isIntInRange(count, { min: 0, max: SALE_COUNT_MAX })) {
    refuse({ reason: 'invalid_sale_count', field: 'saleCount' });
  }
  return count;
}

function refundRefsOf(fact: ShiftCloseFact): string[] {
  const given = fact.cashRefundReturnRefs;
  if (given.length > REFUND_REFS_MAX) {
    refuse({ reason: 'invalid_refund_refs', field: 'cashRefundReturnRefs' });
  }
  const refs = given.map((value) => lowerUuid({ field: 'cashRefundReturnRefs', value }));
  if (new Set(refs).size !== refs.length) {
    refuse({ reason: 'invalid_refund_refs', field: 'cashRefundReturnRefs' });
  }
  return refs;
}

function approverOf(fact: ShiftCloseFact): { varianceApprovedByUserId?: string } {
  const approver = fact.varianceApprovedByUserId;
  if (approver === undefined) return {};
  return {
    varianceApprovedByUserId: lowerUuid({ field: 'varianceApprovedByUserId', value: approver }),
  };
}

/** The `closeShift` body and key (device path, `closeKind: normal`). */
export function buildCloseShiftRequest(
  input: InShiftCurrency<ShiftCloseFact>,
): BuiltShiftFact<ShiftCloseFact> {
  const amounts = closeAmounts(input);
  checkArithmetic(input.fact);
  const fact: ShiftCloseFact = {
    ...input.fact,
    shiftId: lowerUuid({ field: 'shiftId', value: input.fact.shiftId }),
    closedAt: isoInstant({ field: 'closedAt', value: input.fact.closedAt }),
    closingUserId: lowerUuid({ field: 'closingUserId', value: input.fact.closingUserId }),
    saleCount: saleCountOf(input.fact),
    cashRefundReturnRefs: refundRefsOf(input.fact),
    ...approverOf(input.fact),
  };
  const body = {
    closedAt: fact.closedAt,
    closingUserId: fact.closingUserId,
    closeKind: 'normal',
    ...amounts,
    saleCount: fact.saleCount,
    cashRefundReturnRefs: fact.cashRefundReturnRefs,
    ...approverOf(fact),
    operatorUserId: fact.closingUserId,
  };
  return { fact, request: request({ kind: 'close', id: fact.shiftId }, body) };
}

/** The dead-lettered row a repair replaces: its fact and its stored device body. */
export interface EnvelopeRepairSource {
  factKind: ShiftFactKind;
  /** The fact's natural key: the shift id (open, close) or the movement id. */
  factId: string;
  /** The seq of the dead-lettered row; it makes this repair's key unique. */
  supersededSeq: number;
  /** The stored body of the dead-lettered row, byte for byte. */
  deviceBody: string;
}

/**
 * The manager-envelope repair of a dead-lettered fact (RT-17 10919 decision 4):
 * the stored body less `operatorUserId` (an envelope request that carries it
 * is a 401; the claim is not part of the payload hash, so this is the same
 * fact) and a new Idempotency-Key, `<the fact's key>:repair-<superseded seq>`.
 * Exactly-once rests on the natural-key dedupe, not the key: a fact the server
 * already holds replays `200`.
 */
export function buildEnvelopeRepairRequest(source: EnvelopeRepairSource): ShiftWireRequest {
  const stored = JSON.parse(source.deviceBody) as Record<string, unknown>;
  const body = Object.fromEntries(
    Object.entries(stored).filter(([key]) => key !== 'operatorUserId'),
  );
  return {
    idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX[source.factKind]}${source.factId}:repair-${String(source.supersededSeq)}`,
    body: JSON.stringify(body),
  };
}
