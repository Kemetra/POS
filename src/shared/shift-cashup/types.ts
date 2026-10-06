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
 * Part 2 (option A, owner approval in RT-17 comment 10943): a non-zero
 * variance closes only with a manager PIN, verified main-side against the
 * terminal's local manager PIN records; the verified manager (never the
 * closing cashier) becomes the approver. The PIN crosses the bridge once,
 * inward, and is never echoed; no manager identity ever comes back. A manager
 * enrols their PIN with `enrollManagerPin`.
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

/**
 * A manager PIN: 6–8 ASCII digits. Longer than the cashier's 4–6, because the
 * approver is found by the PIN alone among the terminal's managers.
 */
export const MANAGER_PIN_PATTERN = /^\d{6,8}$/;

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
  // A non-zero variance needs a manager PIN (10920: any variance).
  'variance_approval_required',
  // The manager PIN was not accepted. Says nothing about which managers exist.
  'approver_invalid',
  // The terminal's manager PINs are locked out after repeated wrong PINs.
  'approver_locked',
  // The approver must not be the closing cashier (10941 "must" 1).
  'approver_is_closer',
  // Enrolling a manager PIN needs a manager / admin session signed in online.
  'not_manager',
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

/** The approver of a non-zero variance: a manager PIN only (no identity). */
export interface ShiftCloseApprover {
  managerPin: string;
}

/** The blind count, with a manager PIN when the count may not match. */
export interface ShiftCloseRequest {
  countedCashMinor: number;
  approver?: ShiftCloseApprover;
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

/** A signed-in manager's own PIN; the identity and scope are main's. */
export interface ShiftManagerPinEnrollRequest {
  managerPin: string;
}

export type ShiftManagerPinEnrollResponse = { kind: 'enrolled' } | ShiftCashupRefused;

export interface ShiftCashupBridgeAPI {
  open(req: ShiftOpenRequest): Promise<ShiftOpenResponse>;
  payIn(req: ShiftMovementRequest): Promise<ShiftMovementResponse>;
  payOut(req: ShiftMovementRequest): Promise<ShiftMovementResponse>;
  close(req: ShiftCloseRequest): Promise<ShiftCloseResponse>;
  status(): Promise<ShiftStatusResponse>;
  enrollManagerPin(req: ShiftManagerPinEnrollRequest): Promise<ShiftManagerPinEnrollResponse>;
}
