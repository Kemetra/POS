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
 * Review P2-1 — the clock never runs a shift backwards: a movement or a close
 * whose `now` is before the open shift's `openedAt`, or an open whose `now`
 * is not strictly after the terminal's last local close, is refused
 * (`clock_regressed`) rather than recorded out of order. The cash-up window
 * starts after that last close, its instant excluded (see
 * `shift-cashup-sources.ts`), so an open in the close's own millisecond
 * would leave activity later in that millisecond to neither shift (Codex
 * round 2): the next open is at least 1 ms after the close.
 *
 * Review P2-2 — drawer activity in flight: while the terminal has a refund
 * payout started but not completed, or a settled payment the finalize
 * listener has not turned into a sale yet, the drawer holds (or lacks) cash
 * the cash-up cannot read. The close is refused (`drawer_activity_pending`),
 * and so is every pay-out: its guard compares against that same under-read
 * expected cash. So is an open (Codex round 2): activity started before the
 * open and completed after it would land in the new shift's window although
 * the opening float already reflects it. A pay-in only adds cash and is not
 * held. The status shows both counts (`pendingDrawerActivity`).
 *
 *   openShift           the float, in the terminal's capture currency.
 *   recordCashMovement  a pay-in or pay-out on the open shift. Carried item
 *                       (a): a pay-out above the expected drawer cash right
 *                       now is refused (`pay_out_exceeds_drawer_cash`), so a
 *                       mistyped pay-out cannot make the shift un-closable
 *                       (the close's expected cash must not be negative).
 *   closeShift          a normal close (device path): the POS computes the
 *                       cash-up over its window (see above) and the counted
 *                       cash gives the variance. A non-zero variance needs an
 *                       approval (10920: manager PIN for any variance,
 *                       threshold 0), else `variance_approval_required`; the
 *                       approving manager's users.id is recorded as
 *                       `varianceApprovedByUserId` only for a non-zero
 *                       variance (the contract: the manager who approved a
 *                       non-zero variance).
 *   verifyApprover      RT-17 slice 4 part 2 (option A, 10943; review round
 *                       1). No oracle (P2-4): it first runs the close's whole
 *                       synchronous pre-check — admission as above, a usable
 *                       pairing, the open shift at now (clock), the drawer
 *                       settled, the cash-up — and computes the variance of
 *                       the counted cash. A zero variance needs no approver:
 *                       null, and no PIN is checked. Otherwise it verifies the
 *                       PIN of ONE manager, named by the opaque `managerRef`
 *                       of `listApprovers` (Codex P1), against the local
 *                       records (`manager-pin-store.ts`), at the close's
 *                       instant. After that await it checks again the flag,
 *                       the same session, the lock and the same RT-215
 *                       pairing epoch, then refuses a wrong PIN or unknown
 *                       manager (`approver_invalid`), a record under lockout
 *                       (`approver_locked`), a record whose manager has not
 *                       signed in online on this terminal for 30 days
 *                       (`approver_expired`) and the closing cashier
 *                       (`approver_is_closer`, 10941 "must" 1); each such
 *                       failure is tallied for the shift (`approverFailure`).
 *                       It returns an opaque approval bound to the session,
 *                       the pairing epoch, the shift, the counted cash and
 *                       the variance (P2-3).
 *                       `closeShift` of this service accepts it once (spent
 *                       even when the close is then refused), in the same
 *                       session and pairing epoch (else `approver_invalid` /
 *                       `no_session`), and only for the same shift, count and
 *                       variance (else `approval_stale`: a sale or refund
 *                       landed since). An approver id can therefore never
 *                       reach a close unverified, nor approve another close.
 *   listApprovers       the current scope's managers with a valid record —
 *                       `{ managerRef, displayName }`, never a users.id —
 *                       gated on the flag, an unlocked session of any role and
 *                       a usable pairing.
 *   readStatus          read-only (see `shift-cashup-status.ts`). RT-17 slice
 *                       4: gated on the flag AND an unlocked operator session
 *                       (any role: steps 1–3 only), re-checked after its
 *                       one await (the pairing read) together with the paired
 *                       scope (review round 1) and — F2, 10944 — the RT-215
 *                       pairing epoch, so a revocation or a re-pair (even of
 *                       the same terminal id) in between refuses; it adds the
 *                       open shift's probe refusals (below). The recording
 *                       calls are synchronous: nothing is awaited between
 *                       their admission and their write, so they need no
 *                       re-check.
 *
 * F1 (10944) — a pay-in is refused (`aggregate_out_of_range`) when it would
 * take the shift's pay-in total or its expected cash past the safe-integer
 * range (checked in `bigint` before anything is written), so a pay-in valid on
 * its own can never make the shift impossible to close. An opening float is
 * the whole aggregate at the open, already a checked safe integer.
 *
 * RT-17 slice 4 — probing the blind count (10941 item 3): a pay-out refused
 * above the expected drawer cash, and a close refused for a non-zero variance
 * without an approver, are tallied per shift in memory
 * (`shift-probe-tally.ts`) and shown in the status (`probeRefusals`); so is
 * every failed approver attempt (review round 1 P2-4, `approverFailure`).
 *
 * Refusals of the shift state (`ShiftCashupStateError`) and of a fact's values
 * (`ShiftFactInvalidError`, `ShiftCashupSourceError`) come through unchanged.
 * No audit event is written (part 1, decision 4). Errors name a closed reason,
 * never a value (P7).
 */
import type {
  EnrolledManager,
  ManagerPinStore,
  ManagerPinVerdict,
} from '../operator/manager-pin-store.js';
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
import {
  createShiftProbeTally,
  type ShiftProbeKind,
  type ShiftProbeRefusals,
} from './shift-probe-tally.js';
import type { CashMovementKind, CashMovementReasonCode, ShiftCloseFact } from './shift-wire.js';

export type ShiftCashupRefusalReason =
  | 'feature_disabled'
  | 'no_session'
  | 'session_locked'
  | 'no_cashier_identity'
  | 'pay_out_exceeds_drawer_cash'
  | 'variance_approval_required'
  | 'clock_regressed'
  | 'drawer_activity_pending'
  | 'approver_invalid'
  | 'approver_locked'
  | 'approver_is_closer'
  | 'approver_expired'
  | 'approval_stale'
  | 'aggregate_out_of_range';

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
  'operator_session_id' | 'tenant_id' | 'branch_id' | 'terminal_id' | 'user_id'
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

/**
 * A verified manager approval (`verifyApprover`): opaque, single-use, bound to
 * the session and the pairing it was verified under, and to the close it was
 * given for (shift, counted cash, variance). Only one this service issued is
 * accepted.
 */
export interface VerifiedApprover {
  readonly userId: string;
  readonly operatorSessionId: string;
  readonly pairingEpoch: string;
  readonly shiftId: string;
  readonly countedCashMinor: number;
  readonly varianceMinor: number;
}

export interface VerifyApproverInput {
  /** The blind count the close will submit. */
  countedCashMinor: number;
  /** The opaque handle of one manager (`listApprovers`). */
  managerRef: string;
  managerPin: string;
}

export interface CloseShiftInput {
  countedCashMinor: number;
  /** The manager who approves a non-zero variance (from `verifyApprover`). */
  approver?: VerifiedApprover;
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

/** The status with the open shift's probe refusals (RT-17 slice 4). */
export interface ShiftCashupServiceStatus extends ShiftCashupStatus {
  probeRefusals: ShiftProbeRefusals;
}

export interface ShiftCashupService {
  openShift(input: OpenShiftInput): OpenedShift;
  recordCashMovement(input: CashMovementInput): RecordedCashMovement;
  closeShift(input: CloseShiftInput): ClosedShift;
  /** Null when the count needs no approver (a zero variance). */
  verifyApprover(input: VerifyApproverInput): Promise<VerifiedApprover | null>;
  listApprovers(): EnrolledManager[];
  readStatus(): Promise<ShiftCashupServiceStatus>;
}

export interface ShiftCashupServiceDeps {
  /** `POS_PULSE_FEATURE_SHIFT_CASHUP`, read per call. */
  isEnabled: () => boolean;
  /** The operator session on the paired terminal; null when none or unpaired. */
  getSession: () => ShiftCashupSession | null;
  isSessionLocked: () => boolean;
  /** The current pairing's scope (for the status); null while unpaired. */
  pairedScope: () => Promise<ShiftScope | null>;
  /** `PairingStore.getPairingEpoch` (RT-215) — null while unpaired or revoked. */
  pairingEpoch: () => string | null;
  /** The local manager PIN records (option A). */
  managerPins: Pick<ManagerPinStore, 'verify' | 'list'>;
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

/** A refusal that answers a probe of the blind count, on `shiftId`. */
interface Probe {
  shiftId: string;
  kind: ShiftProbeKind;
  reason: ShiftCashupRefusalReason;
}

interface Actor {
  session: ShiftCashupSession;
  scope: ShiftScope;
  userId: string;
}

/** The close's synchronous pre-check, done: the shift, its cash-up, the variance. */
interface ClosePlan {
  open: OpenShiftView;
  closedAt: string;
  cashup: Cashup;
  varianceMinor: number;
}

/** What a close records: the open shift, the computed cash-up and the count. */
interface CloseParts {
  open: OpenShiftView;
  closedAt: string;
  closingUserId: string;
  cashup: Cashup;
  countedCashMinor: number;
  approverUserId: string | undefined;
}

function scopeOf(session: ShiftCashupSession): ShiftScope {
  return {
    tenantId: session.tenant_id,
    branchId: session.branch_id,
    terminalId: session.terminal_id,
  };
}

/** True when `scope` is the session's own (tenant, branch, terminal). */
function isScopeOf(input: { scope: ShiftScope | null; session: ShiftCashupSession }): boolean {
  const { scope } = input;
  if (scope === null) return false;
  const own = scopeOf(input.session);
  return (['tenantId', 'branchId', 'terminalId'] as const).every((key) => scope[key] === own[key]);
}

function refuse(reason: ShiftCashupRefusalReason): never {
  throw new ShiftCashupRefusedError(reason);
}

function shiftNotOpen(): never {
  throw new ShiftCashupStateError('shift_not_open');
}

/** 10920: any non-zero variance needs an approver, recorded for it alone. */
function approverOf(input: { varianceMinor: number; approverUserId: string | undefined }): {
  varianceApprovedByUserId?: string;
} {
  if (input.varianceMinor === 0) return {};
  const approver = input.approverUserId ?? refuse('variance_approval_required');
  return { varianceApprovedByUserId: approver };
}

const VERDICT_REFUSALS = {
  invalid: 'approver_invalid',
  locked: 'approver_locked',
  expired: 'approver_expired',
} as const;

/** The verified manager's users.id, or the refusal of the verdict. */
function approverIdOf(input: {
  verdict: ManagerPinVerdict;
  closerUserId: string;
}): { userId: string } | { refusal: ShiftCashupRefusalReason } {
  const { verdict } = input;
  if (verdict.kind !== 'verified') return { refusal: VERDICT_REFUSALS[verdict.kind] };
  if (verdict.userId === input.closerUserId.toLowerCase()) return { refusal: 'approver_is_closer' };
  return { userId: verdict.userId };
}

/** P2-3: the approval was given for this very close. */
function requireSameClose(input: {
  approver: VerifiedApprover;
  plan: ClosePlan;
  countedCashMinor: number;
}): void {
  const { approver, plan } = input;
  const same =
    approver.shiftId === plan.open.shiftId &&
    approver.countedCashMinor === input.countedCashMinor &&
    approver.varianceMinor === plan.varianceMinor;
  if (!same) refuse('approval_stale');
}

/** F1: a shift aggregate must stay a safe integer (checked in `bigint`). */
function requireSafeAggregate(total: bigint): void {
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) refuse('aggregate_out_of_range');
}

/**
 * Review P2-1: `now` must lie at least `gapMs` after `floor` (an instant),
 * else `clock_regressed`. 0 = not before (a fact on the open shift); 1 =
 * strictly after, in whole-millisecond instants (an open after a close).
 */
function requireClockFrom(input: { now: string; floor: string | null; gapMs: 0 | 1 }): void {
  if (input.floor === null) return;
  if (Date.parse(input.now) - Date.parse(input.floor) < input.gapMs) refuse('clock_regressed');
}

/** Review P2-2: no drawer cash in flight on the terminal, else `drawer_activity_pending`. */
function requireDrawerSettled(input: { sources: ShiftCashupSources; scope: ShiftScope }): void {
  const pending = input.sources.pendingDrawerActivity(input.scope);
  if (pending.refundPayouts + pending.unfinalizedSales > 0) refuse('drawer_activity_pending');
}

function closeFactOf(parts: CloseParts): ShiftCloseFact {
  const { open, cashup } = parts;
  const varianceMinor = parts.countedCashMinor - cashup.expectedCashMinor;
  return {
    shiftId: open.shiftId,
    closedAt: parts.closedAt,
    closingUserId: parts.closingUserId,
    openingFloatMinor: open.openingFloatMinor,
    payInTotalMinor: open.payInTotalMinor,
    payOutTotalMinor: open.payOutTotalMinor,
    ...cashup,
    countedCashMinor: parts.countedCashMinor,
    varianceMinor,
    ...approverOf({ varianceMinor, approverUserId: parts.approverUserId }),
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
  const tally = createShiftProbeTally();
  /** Approvals issued by `verifyApprover` and not yet used. */
  const issued = new WeakSet<VerifiedApprover>();

  /** Steps 1–3: the flag, then an unlocked session on the paired terminal. */
  function requireSession(): ShiftCashupSession {
    if (!deps.isEnabled()) refuse('feature_disabled');
    const session = deps.getSession() ?? refuse('no_session');
    if (deps.isSessionLocked()) refuse('session_locked');
    return session;
  }

  /** The admitted cashier (module header, steps 1–4). */
  function admit(): Actor {
    const session = requireSession();
    const userId = session.user_id ?? refuse('no_cashier_identity');
    return { session, scope: scopeOf(session), userId };
  }

  /** The usable pairing's RT-215 epoch, captured before an await. */
  function currentEpoch(): string {
    return deps.pairingEpoch() ?? refuse('no_session');
  }

  /** After an await: the same operator session, under the same pairing epoch. */
  function recheckSession(input: {
    admitted: ShiftCashupSession;
    epoch: string;
  }): ShiftCashupSession {
    const live = requireSession();
    if (live.operator_session_id !== input.admitted.operator_session_id) refuse('no_session');
    if (deps.pairingEpoch() !== input.epoch) refuse('no_session');
    return live;
  }

  /**
   * An approval this service issued (used up here), for this session and
   * pairing. The closer was refused at its verification, in this session.
   */
  function acceptApprover(input: { approver: VerifiedApprover; actor: Actor }): VerifiedApprover {
    const { approver, actor } = input;
    if (!issued.delete(approver)) refuse('approver_invalid');
    if (approver.operatorSessionId !== actor.session.operator_session_id) refuse('no_session');
    if (deps.pairingEpoch() !== approver.pairingEpoch) refuse('no_session');
    return approver;
  }

  /**
   * Review round 1: the status read awaits the pairing (secret-store backed),
   * so the admission is re-checked right after it — the flag, the same
   * operator session (its id), still unlocked, and the paired scope still the
   * session's own. A sign-out, a lock or a replaced session refuse as at
   * admission; a revoked or re-paired device (no paired scope, or another
   * one) refuses `no_session`, as an unpaired terminal has no session.
   */
  function recheckAfterRead(input: {
    admitted: ShiftCashupSession;
    epoch: string;
    scope: ShiftScope | null;
  }): ShiftScope {
    const live = recheckSession(input);
    if (!isScopeOf({ scope: input.scope, session: live })) refuse('no_session');
    return scopeOf(live);
  }

  /** The cash-up of the open shift from its open (after the last close) up to `until`. */
  function cashupOf(input: { scope: ShiftScope; open: OpenShiftView; until: string }): Cashup {
    const { scope, open } = input;
    const after = deps.sources.lastClosedAt(scope);
    const query = { scope, window: { from: open.openedAt, after, to: input.until } };
    return computeCashup({
      currencyCode: open.currencyCode,
      openingFloatMinor: open.openingFloatMinor,
      payInTotalMinor: open.payInTotalMinor,
      payOutTotalMinor: open.payOutTotalMinor,
      sales: deps.sources.salesIn(query),
      refunds: deps.sources.refundsIn(query),
    });
  }

  /** The terminal's open shift at `now`, never before its open (P2-1). */
  function openShiftAt(input: { scope: ShiftScope; now: string }): OpenShiftView {
    const open = repo.findOpenShift(input.scope) ?? shiftNotOpen();
    requireClockFrom({ now: input.now, floor: open.openedAt, gapMs: 0 });
    return open;
  }

  /**
   * The close's synchronous pre-check at now: the open shift (never before its
   * open), no drawer cash in flight, the cash-up, and the count's variance.
   */
  function planClose(input: { scope: ShiftScope; countedCashMinor: number }): ClosePlan {
    const { scope } = input;
    const closedAt = deps.now();
    const open = openShiftAt({ scope, now: closedAt });
    requireDrawerSettled({ sources: deps.sources, scope });
    const cashup = cashupOf({ scope, open, until: closedAt });
    const varianceMinor = input.countedCashMinor - cashup.expectedCashMinor;
    return { open, closedAt, cashup, varianceMinor };
  }

  /** Runs `run`; a refusal of `probe.reason` is tallied for its shift (slice 4 probe). */
  function tallied<T>(probe: Probe, run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof ShiftCashupRefusedError && error.reason === probe.reason) {
        tally.record(probe);
      }
      throw error;
    }
  }

  /**
   * F1 (10944): a pay-in never takes the pay-in total or the expected cash
   * past the safe-integer range, so the shift stays closable.
   */
  function guardPayIn(input: {
    scope: ShiftScope;
    open: OpenShiftView;
    movement: CashMovementInput;
    now: string;
  }): void {
    if (input.movement.kind !== 'pay_in') return;
    const amount = BigInt(input.movement.amountMinor);
    requireSafeAggregate(BigInt(input.open.payInTotalMinor) + amount);
    const { expectedCashMinor } = cashupOf({ ...input, until: input.now });
    requireSafeAggregate(BigInt(expectedCashMinor) + amount);
  }

  /**
   * Carried item (a): a pay-out never takes the expected drawer cash below
   * zero — and is held while drawer cash is in flight (P2-2), since the
   * expected cash is then under-read.
   */
  function guardPayOut(input: {
    scope: ShiftScope;
    open: OpenShiftView;
    movement: CashMovementInput;
    now: string;
  }): void {
    if (input.movement.kind !== 'pay_out') return;
    requireDrawerSettled({ sources: deps.sources, scope: input.scope });
    const { expectedCashMinor } = cashupOf({ ...input, until: input.now });
    if (input.movement.amountMinor <= expectedCashMinor) return;
    tally.record({ shiftId: input.open.shiftId, kind: 'payOut' });
    refuse('pay_out_exceeds_drawer_cash');
  }

  return {
    openShift(input) {
      const { scope, userId } = admit();
      const now = deps.now();
      requireClockFrom({ now, floor: deps.sources.lastClosedAt(scope), gapMs: 1 });
      requireDrawerSettled({ sources: deps.sources, scope });
      const opened = { shiftId: deps.newId(), openedAt: now };
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
      const now = deps.now();
      const open = openShiftAt({ scope, now });
      guardPayIn({ scope, open, movement: input, now });
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
      const actor = admit();
      const { scope, userId } = actor;
      const { countedCashMinor } = input;
      const approver =
        input.approver === undefined
          ? undefined
          : acceptApprover({ approver: input.approver, actor });
      const plan = planClose({ scope, countedCashMinor });
      if (approver !== undefined) requireSameClose({ approver, plan, countedCashMinor });
      const { open, closedAt, cashup } = plan;
      const probe = {
        shiftId: open.shiftId,
        kind: 'varianceClose',
        reason: 'variance_approval_required',
      } as const;
      const fact = tallied(probe, () =>
        closeFactOf({
          open,
          closedAt,
          closingUserId: userId,
          cashup,
          countedCashMinor,
          approverUserId: approver?.userId,
        }),
      );
      repo.recordClose({ scope, fact, now: closedAt });
      return closedShiftOf(fact);
    },

    async verifyApprover(input) {
      const { session: admitted, scope, userId: closerUserId } = admit();
      const epoch = currentEpoch();
      const { countedCashMinor } = input;
      const plan = planClose({ scope, countedCashMinor });
      if (plan.varianceMinor === 0) return null;
      const verdict = await deps.managerPins.verify({
        scope,
        managerRef: input.managerRef,
        pin: input.managerPin,
        now: plan.closedAt,
      });
      const live = recheckSession({ admitted, epoch });
      const checked = approverIdOf({ verdict, closerUserId });
      if ('refusal' in checked) {
        tally.record({ shiftId: plan.open.shiftId, kind: 'approverFailure' });
        refuse(checked.refusal);
      }
      const approver: VerifiedApprover = Object.freeze({
        userId: checked.userId,
        operatorSessionId: live.operator_session_id,
        pairingEpoch: epoch,
        shiftId: plan.open.shiftId,
        countedCashMinor,
        varianceMinor: plan.varianceMinor,
      });
      issued.add(approver);
      return approver;
    },

    listApprovers() {
      const session = requireSession();
      currentEpoch();
      return deps.managerPins.list({ scope: scopeOf(session), now: deps.now() });
    },

    async readStatus() {
      const admitted = requireSession();
      const epoch = currentEpoch();
      const paired = await deps.pairedScope();
      const scope = recheckAfterRead({ admitted, epoch, scope: paired });
      const status = deps.status.read({ scope, now: deps.now() });
      return { ...status, probeRefusals: tally.countsFor(status.openShift?.shiftId ?? null) };
    },
  };
}
