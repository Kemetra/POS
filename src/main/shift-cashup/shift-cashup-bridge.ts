/**
 * RT-17 slice 4 part 1 — the main-side `shiftCashup.*` bridge: the shift
 * cash-up service as the renderer may see it.
 *
 *   • Every typed refusal becomes a closed `{ kind: 'refused', reason }`
 *     envelope. The precise reason is logged main-side only
 *     (`shift_cashup:refused {op, reason}`, closed-set values, P7); an
 *     unexpected failure answers `unavailable` and logs the error's name only.
 *   • Probing the blind count (10941 item 3): a pay-out above the expected
 *     drawer cash answers the generic `pay_out_not_accepted` — no amount, no
 *     bound. The service tallies it (and a close refused for a non-zero
 *     variance) per shift for the status.
 *   • Part 2 (option A, 10943): a close may carry a manager PIN. The bridge
 *     has the service verify it first (`verifyApprover`: local manager PIN
 *     records, lockout, re-checked session and pairing) and passes only the
 *     resulting approval to the close; no approver id ever comes from the
 *     renderer. Without a PIN a non-zero variance is refused
 *     `variance_approval_required`. The refusals `approver_invalid`,
 *     `approver_locked` and `approver_is_closer` say nothing about which
 *     managers exist.
 *   • `enrollManagerPin`: a signed-in manager sets their own PIN
 *     (`manager-pin-enrollment.ts`); the bridge passes the PIN alone.
 *   • A PIN is never logged or echoed: refusals log closed-set reasons, and an
 *     unexpected failure its error name only.
 *   • Nothing that reveals the expected cash, and no `users.id`, crosses the
 *     bridge: the close answers its id and time only, and the status is an
 *     explicit allowlist (no `openingUserId`).
 *
 * Admission (flag, session, lock, cashier or manager identity) is the
 * service's and the enrolment's: every call goes through it.
 */
import type {
  ShiftCashupBridgeAPI,
  ShiftCashupRefusal,
  ShiftCashupRefused,
  ShiftMovementRequest,
  ShiftOpenShiftView,
  ShiftStatusView,
} from '../../shared/shift-cashup/types.js';
import {
  ManagerPinRefusedError,
  type ManagerPinEnrollment,
  type ManagerPinRefusalReason,
} from '../operator/manager-pin-enrollment.js';
import { ShiftCashupSourceError } from './shift-cashup-calculator.js';
import { ShiftCashupStateError, type OpenShiftView } from './shift-cashup-repo.js';
import {
  ShiftCashupRefusedError,
  type CashMovementInput,
  type ShiftCashupRefusalReason,
  type ShiftCashupService,
  type ShiftCashupServiceStatus,
} from './shift-cashup-service.js';
import { ShiftFactInvalidError, type CashMovementKind } from './shift-wire.js';

export const SHIFT_CASHUP_REFUSED_LOG = 'shift_cashup:refused';
export const SHIFT_CASHUP_FAILED_LOG = 'shift_cashup:failed';

type ShiftCashupOp = keyof ShiftCashupBridgeAPI;

export interface ShiftCashupBridgeLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface ShiftCashupBridgeDeps {
  service: ShiftCashupService;
  enrollment: ManagerPinEnrollment;
  logger: ShiftCashupBridgeLogger;
}

/** The service's refusals as the renderer sees them (two generic on purpose). */
const SERVICE_REFUSALS: Readonly<Record<ShiftCashupRefusalReason, ShiftCashupRefusal>> = {
  feature_disabled: 'feature_disabled',
  no_session: 'no_session',
  session_locked: 'session_locked',
  no_cashier_identity: 'no_cashier_identity',
  pay_out_exceeds_drawer_cash: 'pay_out_not_accepted',
  variance_approval_required: 'variance_approval_required',
  clock_regressed: 'clock_regressed',
  drawer_activity_pending: 'drawer_activity_pending',
  approver_invalid: 'approver_invalid',
  approver_locked: 'approver_locked',
  approver_is_closer: 'approver_is_closer',
  aggregate_out_of_range: 'invalid_input',
};

/** The enrolment's refusals as the renderer sees them. */
const ENROLMENT_REFUSALS: Readonly<Record<ManagerPinRefusalReason, ShiftCashupRefusal>> = {
  feature_disabled: 'feature_disabled',
  no_session: 'no_session',
  session_locked: 'session_locked',
  not_manager: 'not_manager',
  no_manager_identity: 'not_manager',
  invalid_pin: 'invalid_input',
};

/** A known refusal: the precise (logged) reason and the renderer's. */
interface Classified {
  internal: string;
  refusal: ShiftCashupRefusal;
}

function stateRefusal(error: ShiftCashupStateError): ShiftCashupRefusal {
  return error.reason === 'not_dead_lettered' ? 'unavailable' : error.reason;
}

function classify(error: unknown): Classified | null {
  if (error instanceof ShiftCashupRefusedError) {
    return { internal: error.reason, refusal: SERVICE_REFUSALS[error.reason] };
  }
  if (error instanceof ShiftCashupStateError) {
    return { internal: error.reason, refusal: stateRefusal(error) };
  }
  if (error instanceof ShiftFactInvalidError) {
    return { internal: error.reason, refusal: 'invalid_input' };
  }
  if (error instanceof ShiftCashupSourceError) {
    return { internal: error.reason, refusal: 'cashup_unavailable' };
  }
  if (error instanceof ManagerPinRefusedError) {
    return { internal: error.reason, refusal: ENROLMENT_REFUSALS[error.reason] };
  }
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function openShiftView(open: OpenShiftView | null): ShiftOpenShiftView | null {
  if (open === null) return null;
  return {
    shiftId: open.shiftId,
    openedAt: open.openedAt,
    currencyCode: open.currencyCode,
    openingFloatMinor: open.openingFloatMinor,
    payInTotalMinor: open.payInTotalMinor,
    payOutTotalMinor: open.payOutTotalMinor,
  };
}

/** The renderer's status: an explicit allowlist (see the module header). */
function statusView(status: ShiftCashupServiceStatus): ShiftStatusView {
  const { queue, stranded, pendingDrawerActivity, probeRefusals } = status;
  return {
    openShift: openShiftView(status.openShift),
    queue: { ...queue },
    stranded: { ...stranded },
    pendingDrawerActivity: { ...pendingDrawerActivity },
    probeRefusals: { ...probeRefusals },
  };
}

function movementOf(kind: CashMovementKind, req: ShiftMovementRequest): CashMovementInput {
  const { amountMinor, reasonCode, note } = req;
  return { kind, amountMinor, reasonCode, ...(note === undefined ? {} : { note }) };
}

export function createShiftCashupBridge(deps: ShiftCashupBridgeDeps): ShiftCashupBridgeAPI {
  const { service, enrollment, logger } = deps;

  function refusedFor(op: ShiftCashupOp, error: unknown): ShiftCashupRefused {
    const known = classify(error);
    if (known === null) {
      logger.warn({ op, error: errorName(error) }, SHIFT_CASHUP_FAILED_LOG);
      return { kind: 'refused', reason: 'unavailable' };
    }
    logger.info({ op, reason: known.internal }, SHIFT_CASHUP_REFUSED_LOG);
    return { kind: 'refused', reason: known.refusal };
  }

  async function attempt<T>(
    op: ShiftCashupOp,
    run: () => T | Promise<T>,
  ): Promise<T | ShiftCashupRefused> {
    try {
      return await run();
    } catch (error) {
      return refusedFor(op, error);
    }
  }

  function move(op: 'payIn' | 'payOut', kind: CashMovementKind, req: ShiftMovementRequest) {
    return attempt(op, () => {
      const moved = service.recordCashMovement(movementOf(kind, req));
      return { kind: 'recorded' as const, ...moved };
    });
  }

  return {
    open: (req) =>
      attempt('open', () => {
        const opened = service.openShift({ openingFloatMinor: req.openingFloatMinor });
        return { kind: 'opened' as const, ...opened };
      }),
    payIn: (req) => move('payIn', 'pay_in', req),
    payOut: (req) => move('payOut', 'pay_out', req),
    close: (req) =>
      attempt('close', async () => {
        // The approval comes from the service's own verification of the PIN,
        // never from the request (part 2, 10943).
        const pin = req.approver?.managerPin;
        const approver =
          pin === undefined ? {} : { approver: await service.verifyApprover({ managerPin: pin }) };
        const closed = service.closeShift({ countedCashMinor: req.countedCashMinor, ...approver });
        return { kind: 'closed' as const, shiftId: closed.shiftId, closedAt: closed.closedAt };
      }),
    status: () =>
      attempt('status', async () => ({
        kind: 'status' as const,
        status: statusView(await service.readStatus()),
      })),
    enrollManagerPin: (req) =>
      attempt('enrollManagerPin', async () => {
        await enrollment.enroll({ managerPin: req.managerPin });
        return { kind: 'enrolled' as const };
      }),
  };
}
