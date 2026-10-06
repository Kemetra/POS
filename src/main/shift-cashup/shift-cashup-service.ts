/**
 * RT-17 slice 3 part 3 — the main-process shift cash-up service, for the
 * slice 4 UI to consume (no IPC in this part).
 *
 * Every call passes the same admission, in order, before anything is read or
 * written (`ShiftCashupRefusedError` otherwise):
 *   1. `POS_PULSE_FEATURE_SHIFT_CASHUP` on (default OFF, 10920) — read per
 *      call — else `feature_disabled`;
 *   2. an operator session on a paired terminal, else `no_session`;
 *   3. the session unlocked, else `session_locked`;
 *   4. the session's `users.id`, else `no_cashier_identity`. Only an admitted
 *      cashier session has one (RT-113 P2), and the device path needs it as
 *      `operatorUserId` (part 1, decision 3). Manager / admin facts go through
 *      the manager envelope, a later part of RT-17.
 *
 * Each fact is attributed to that cashier and recorded on the session's scope
 * (tenant, branch, current pairing's terminal) through the part 1 repository,
 * which builds and stores its exact request once (the shift sync engine sends
 * it later). The clock is read once per call. The service is synchronous: a
 * cash-up and the fact it guards are computed and recorded in one turn of the
 * main thread, so no sale or payout lands in between.
 *
 *   openShift           the float, in the terminal's capture currency.
 *   recordCashMovement  a pay-in or pay-out on the open shift. Carried item
 *                       (a): a pay-out above the expected drawer cash right
 *                       now is refused (`pay_out_exceeds_drawer_cash`), so a
 *                       mistyped pay-out cannot make the shift un-closable
 *                       (the close's expected cash must not be negative).
 *   closeShift          a normal close (device path): the POS computes the
 *                       cash-up over [openedAt, closedAt] (both ends
 *                       included) and the counted cash gives the variance.
 *                       A non-zero variance needs `varianceApprovedByUserId`
 *                       (10920: manager PIN for any variance, threshold 0),
 *                       else `variance_approval_required`. The approver id is
 *                       the main-side caller's to verify (slice 4's manager
 *                       PIN); it never comes from the renderer unverified.
 *   readStatus          read-only (see `shift-cashup-status.ts`).
 *
 * Refusals of the shift state (`ShiftCashupStateError`) and of a fact's values
 * (`ShiftFactInvalidError`, `ShiftCashupSourceError`) come through unchanged.
 * No audit event is written (part 1, decision 4). Errors name a closed reason,
 * never a value (P7).
 */
import type { OperatorSessionForPayments } from '../payments/require-operator-session.js';
import { computeCashup, type Cashup } from './shift-cashup-calculator.js';
import {
  ShiftCashupStateError,
  type OpenShiftView,
  type ShiftCashupRepo,
  type ShiftScope,
} from './shift-cashup-repo.js';
import type { ShiftCashupSources } from './shift-cashup-sources.js';
import type { ShiftCashupStatus, ShiftCashupStatusReader } from './shift-cashup-status.js';
import type { CashMovementKind, CashMovementReasonCode, ShiftCloseFact } from './shift-wire.js';

export type ShiftCashupRefusalReason =
  | 'feature_disabled'
  | 'no_session'
  | 'session_locked'
  | 'no_cashier_identity'
  | 'pay_out_exceeds_drawer_cash'
  | 'variance_approval_required';

/** A call the service refuses before recording anything. */
export class ShiftCashupRefusedError extends Error {
  readonly reason: ShiftCashupRefusalReason;

  constructor(reason: ShiftCashupRefusalReason) {
    super(`shift cash-up refused: ${reason}`);
    this.name = 'ShiftCashupRefusedError';
    this.reason = reason;
  }
}

/** The session scope the service needs (`resolveSessionScope`'s result). */
export type ShiftCashupSession = Pick<
  OperatorSessionForPayments,
  'tenant_id' | 'branch_id' | 'terminal_id' | 'user_id'
>;

export interface OpenShiftInput {
  openingFloatMinor: number;
}

export interface OpenedShift {
  shiftId: string;
  openedAt: string;
}

export interface CashMovementInput {
  kind: CashMovementKind;
  amountMinor: number;
  reasonCode: CashMovementReasonCode;
  /** Optional, 1–200 characters, no PII. */
  note?: string;
}

export interface RecordedCashMovement {
  movementId: string;
  shiftId: string;
}

export interface CloseShiftInput {
  countedCashMinor: number;
  /** The manager who approved a non-zero variance (verified by the caller). */
  varianceApprovedByUserId?: string;
}

export interface ClosedShift {
  shiftId: string;
  closedAt: string;
  cashSalesTotalMinor: number;
  cashRefundsTotalMinor: number;
  expectedCashMinor: number;
  countedCashMinor: number;
  varianceMinor: number;
  saleCount: number;
}

export interface ShiftCashupService {
  openShift(input: OpenShiftInput): OpenedShift;
  recordCashMovement(input: CashMovementInput): RecordedCashMovement;
  closeShift(input: CloseShiftInput): ClosedShift;
  readStatus(): Promise<ShiftCashupStatus>;
}

export interface ShiftCashupServiceDeps {
  /** `POS_PULSE_FEATURE_SHIFT_CASHUP`, read per call. */
  isEnabled: () => boolean;
  /** The operator session on the paired terminal; null when none or unpaired. */
  getSession: () => ShiftCashupSession | null;
  isSessionLocked: () => boolean;
  /** The current pairing's scope (for the status); null while unpaired. */
  pairedScope: () => Promise<ShiftScope | null>;
  repo: Pick<ShiftCashupRepo, 'recordOpen' | 'recordMovement' | 'recordClose' | 'findOpenShift'>;
  sources: ShiftCashupSources;
  status: ShiftCashupStatusReader;
  /** The terminal's capture currency (the sale-sync capture's own source). */
  currencyCode: string;
  /** Canonical ISO-8601 UTC instants. */
  now: () => string;
  /** A new lower-case UUID (v7) for a shift or a movement. */
  newId: () => string;
}

interface Actor {
  scope: ShiftScope;
  userId: string;
}

/** What a close records: the open shift, the computed cash-up and the count. */
interface CloseParts {
  open: OpenShiftView;
  closedAt: string;
  closingUserId: string;
  cashup: Cashup;
  input: CloseShiftInput;
}

function refuse(reason: ShiftCashupRefusalReason): never {
  throw new ShiftCashupRefusedError(reason);
}

function shiftNotOpen(): never {
  throw new ShiftCashupStateError('shift_not_open');
}

/** 10920: any non-zero variance needs an approver. */
function approverOf(input: { varianceMinor: number; close: CloseShiftInput }): {
  varianceApprovedByUserId?: string;
} {
  const approver = input.close.varianceApprovedByUserId;
  if (approver !== undefined) return { varianceApprovedByUserId: approver };
  return input.varianceMinor === 0 ? {} : refuse('variance_approval_required');
}

function closeFactOf(parts: CloseParts): ShiftCloseFact {
  const { open, cashup } = parts;
  const varianceMinor = parts.input.countedCashMinor - cashup.expectedCashMinor;
  return {
    shiftId: open.shiftId,
    closedAt: parts.closedAt,
    closingUserId: parts.closingUserId,
    openingFloatMinor: open.openingFloatMinor,
    payInTotalMinor: open.payInTotalMinor,
    payOutTotalMinor: open.payOutTotalMinor,
    ...cashup,
    countedCashMinor: parts.input.countedCashMinor,
    varianceMinor,
    ...approverOf({ varianceMinor, close: parts.input }),
  };
}

function closedShiftOf(fact: ShiftCloseFact): ClosedShift {
  return {
    shiftId: fact.shiftId,
    closedAt: fact.closedAt,
    cashSalesTotalMinor: fact.cashSalesTotalMinor,
    cashRefundsTotalMinor: fact.cashRefundsTotalMinor,
    expectedCashMinor: fact.expectedCashMinor,
    countedCashMinor: fact.countedCashMinor,
    varianceMinor: fact.varianceMinor,
    saleCount: fact.saleCount,
  };
}

export function createShiftCashupService(deps: ShiftCashupServiceDeps): ShiftCashupService {
  const { repo } = deps;

  function requireEnabled(): void {
    if (!deps.isEnabled()) refuse('feature_disabled');
  }

  /** The admitted cashier (module header, steps 1–4). */
  function admit(): Actor {
    requireEnabled();
    const session = deps.getSession() ?? refuse('no_session');
    if (deps.isSessionLocked()) refuse('session_locked');
    const userId = session.user_id ?? refuse('no_cashier_identity');
    const scope = {
      tenantId: session.tenant_id,
      branchId: session.branch_id,
      terminalId: session.terminal_id,
    };
    return { scope, userId };
  }

  /** The cash-up of the open shift from its open up to `until`. */
  function cashupOf(input: { scope: ShiftScope; open: OpenShiftView; until: string }): Cashup {
    const { scope, open } = input;
    const query = { scope, window: { from: open.openedAt, to: input.until } };
    return computeCashup({
      currencyCode: open.currencyCode,
      openingFloatMinor: open.openingFloatMinor,
      payInTotalMinor: open.payInTotalMinor,
      payOutTotalMinor: open.payOutTotalMinor,
      sales: deps.sources.salesIn(query),
      refunds: deps.sources.refundsIn(query),
    });
  }

  /** Carried item (a): a pay-out never takes the expected drawer cash below zero. */
  function guardPayOut(input: {
    scope: ShiftScope;
    open: OpenShiftView;
    movement: CashMovementInput;
    now: string;
  }): void {
    if (input.movement.kind !== 'pay_out') return;
    const { expectedCashMinor } = cashupOf({ ...input, until: input.now });
    if (input.movement.amountMinor > expectedCashMinor) refuse('pay_out_exceeds_drawer_cash');
  }

  return {
    openShift(input) {
      const { scope, userId } = admit();
      const opened = { shiftId: deps.newId(), openedAt: deps.now() };
      repo.recordOpen({
        scope,
        fact: {
          ...opened,
          openingUserId: userId,
          currencyCode: deps.currencyCode,
          openingFloatMinor: input.openingFloatMinor,
        },
        now: opened.openedAt,
      });
      return opened;
    },

    recordCashMovement(input) {
      const { scope, userId } = admit();
      const open = repo.findOpenShift(scope) ?? shiftNotOpen();
      const now = deps.now();
      guardPayOut({ scope, open, movement: input, now });
      const moved = { movementId: deps.newId(), shiftId: open.shiftId };
      repo.recordMovement({
        scope,
        fact: {
          ...moved,
          kind: input.kind,
          amountMinor: input.amountMinor,
          reasonCode: input.reasonCode,
          ...(input.note === undefined ? {} : { note: input.note }),
          occurredAt: now,
          operatorUserId: userId,
        },
        now,
      });
      return moved;
    },

    closeShift(input) {
      const { scope, userId } = admit();
      const open = repo.findOpenShift(scope) ?? shiftNotOpen();
      const closedAt = deps.now();
      const cashup = cashupOf({ scope, open, until: closedAt });
      const fact = closeFactOf({ open, closedAt, closingUserId: userId, cashup, input });
      repo.recordClose({ scope, fact, now: closedAt });
      return closedShiftOf(fact);
    },

    async readStatus() {
      requireEnabled();
      const scope = await deps.pairedScope();
      return deps.status.read({ scope, now: deps.now() });
    },
  };
}
