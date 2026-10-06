/**
 * RT-17 slice 4 — shared types for the shift cash-up bridge (`shiftCashup.*`).
 *
 * Money is integer minor units only. Nothing here carries a `users.id`, the
 * Idempotency-Key, a request body or a server answer: those stay in the main
 * process. Nothing here reveals the expected cash either: the cashier's count
 * is blind (10920 decision 2), so
 *   • the status shows the open shift's float and movement totals only;
 *   • a pay-out above the expected drawer cash is answered with the generic
 *     `pay_out_not_accepted` (no amount, no bound — 10941 item 3);
 *   • the close answers its id and time only.
 *
 * Part 1 accepts a zero-variance close only: the close request has no
 * approver field, and a non-zero variance is refused
 * `variance_approval_unavailable` until the verified-manager approver lands
 * (owner decision pending, RT-17 comment 10942).
 */

/** The pay-in / pay-out reasons of `pos-shifts` 1.1.0-draft. */
export const SHIFT_MOVEMENT_REASON_CODES = [
  'bank_drop',
  'float_top_up',
  'petty_expense',
  'other',
] as const;
export type ShiftMovementReasonCode = (typeof SHIFT_MOVEMENT_REASON_CODES)[number];

/** A movement note: 1–200 characters, no PII (the contract's bound). */
export const SHIFT_NOTE_MAX_LENGTH = 200;

/** Why a `shiftCashup.*` call was refused (closed set; nothing was recorded). */
export const SHIFT_CASHUP_REFUSALS = [
  'feature_disabled',
  'no_session',
  'session_locked',
  // The session has no `users.id` (a manager / admin): the device path
  // records cashier facts only; the manager-envelope path is a later part.
  'no_cashier_identity',
  'invalid_input',
  'shift_already_open',
  'shift_not_open',
  'clock_regressed',
  'drawer_activity_pending',
  // Generic on purpose: never says why, so it reveals no bound on the
  // hidden expected cash (10941 item 3).
  'pay_out_not_accepted',
  // A non-zero variance needs a verified manager approver, not available yet
  // (10942).
  'variance_approval_unavailable',
  // The till cannot compute the cash-up from its own records.
  'cashup_unavailable',
  'unavailable',
] as const;
export type ShiftCashupRefusal = (typeof SHIFT_CASHUP_REFUSALS)[number];

export interface ShiftCashupRefused {
  kind: 'refused';
  reason: ShiftCashupRefusal;
}

export interface ShiftOpenRequest {
  openingFloatMinor: number;
}

export type ShiftOpenResponse =
  | { kind: 'opened'; shiftId: string; openedAt: string }
  | ShiftCashupRefused;

export interface ShiftMovementRequest {
  amountMinor: number;
  reasonCode: ShiftMovementReasonCode;
  note?: string;
}

export type ShiftMovementResponse =
  | { kind: 'recorded'; movementId: string; shiftId: string }
  | ShiftCashupRefused;

/** The blind count. No approver can be sent (see the module header). */
export interface ShiftCloseRequest {
  countedCashMinor: number;
}

export type ShiftCloseResponse =
  | { kind: 'closed'; shiftId: string; closedAt: string }
  | ShiftCashupRefused;

export interface ShiftOpenShiftView {
  shiftId: string;
  openedAt: string;
  currencyCode: string;
  openingFloatMinor: number;
  payInTotalMinor: number;
  payOutTotalMinor: number;
}

export interface ShiftStatusView {
  openShift: ShiftOpenShiftView | null;
  /** The current terminal's unsettled shift facts, by sync state. */
  queue: { pending: number; waiting: number; blocked: number; envelopePending: number };
  /** Unsettled facts and open shifts outside the current pairing. */
  stranded: { unsyncedFacts: number; openShifts: number };
  /** Drawer cash in flight; while non-zero, an open, a pay-out and the close are held. */
  pendingDrawerActivity: { refundPayouts: number; unfinalizedSales: number };
  /**
   * Refusals of the open shift that answer a probe of the blind count (10941
   * item 3), for a manager to see. Kept in memory: zero again after a restart.
   */
  probeRefusals: { payOut: number; varianceClose: number };
}

export type ShiftStatusResponse = { kind: 'status'; status: ShiftStatusView } | ShiftCashupRefused;

export interface ShiftCashupBridgeAPI {
  open(req: ShiftOpenRequest): Promise<ShiftOpenResponse>;
  payIn(req: ShiftMovementRequest): Promise<ShiftMovementResponse>;
  payOut(req: ShiftMovementRequest): Promise<ShiftMovementResponse>;
  close(req: ShiftCloseRequest): Promise<ShiftCloseResponse>;
  status(): Promise<ShiftStatusResponse>;
}
