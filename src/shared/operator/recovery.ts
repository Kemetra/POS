/**
 * RT-441 (RT-116 S6, §5) — manager recovery: the bridge contract.
 *
 * A manager or admin clears a stuck payment, or an abandoned held sale, on
 * THIS terminal without its original operator. Every action consumes its own
 * RT-114 approval (the signed-in manager's PIN, MA-2), bound to the subject
 * and its amount; the audit is dual-attributed (the original operator acts,
 * the manager approves).
 *
 * The bridge carries totals and opaque ids only: no line items, no product
 * names, no park label, no approver identity. `owning_operator_id` is the
 * id the branch roster already shows the renderer; it resolves the name.
 */

export const RECOVERY_IPC_CHANNELS = {
  LIST_HELD: 'recovery:list-held',
  COMPLETE_ATTEMPT: 'recovery:complete-attempt',
  CANCEL_ATTEMPT: 'recovery:cancel-attempt',
  CANCEL_HELD_CART: 'recovery:cancel-held-cart',
} as const;

/** The terminal's stuck payment: started, holding live tender, owned by someone else. */
export interface RecoveryStuckAttemptView {
  payment_attempt_id: string;
  cart_id: string;
  owning_operator_id: string;
  line_count: number;
  total_minor: number;
  /** Live tender by type (applying / applied / reversal_pending), in minor units. */
  cash_minor: number;
  card_minor: number;
  voucher_minor: number;
  remaining_minor: number;
  started_at: string;
}

/** A held sale of another session on this terminal (a draft, or a handed-off cart). */
export interface RecoveryHeldCartView {
  cart_id: string;
  owning_operator_id: string;
  kind: 'draft' | 'handed_off';
  /** Spec 024 §4.3: a parked cart is listed, flagged. Never its label. */
  parked: boolean;
  /** RT-837: the signed-in manager's own held sale (an earlier session's), not another employee's. */
  own: boolean;
  line_count: number;
  total_minor: number;
  updated_at: string;
}

export interface RecoveryHeldView {
  kind: 'held';
  /** The session was admitted to clear a stuck payment (RT-116 §5.1). */
  recovery_mode: boolean;
  stuck: RecoveryStuckAttemptView | null;
  held: RecoveryHeldCartView[];
}

export interface RecoveryCompleteAttemptRequest {
  payment_attempt_id: string;
  approval_id: string;
  /** Cash collected for the remaining balance; required when anything remains. */
  cash_received_minor?: number;
}

export interface RecoveryCancelAttemptRequest {
  payment_attempt_id: string;
  approval_id: string;
  /** Required when any cash line is live: the cash went back to the customer. */
  cash_returned_confirmed?: boolean;
  /** Required when any card-terminal line is live: it was voided on the terminal. */
  card_void_confirmed_on_terminal?: boolean;
}

export interface RecoveryCancelHeldCartRequest {
  cart_id: string;
  approval_id: string;
}

export const RECOVERY_REFUSAL_REASONS = [
  'no_session',
  'session_locked',
  'role_mismatch',
  'invalid_input',
  /** The subject is not (or no longer) a stuck attempt / held cart here. */
  'not_found',
  'approval_invalid',
  'approval_stale',
  /** Live cash or card tender needs its confirmation first (§5.2). */
  'confirmation_required',
  /** Less cash than the remaining balance. */
  'cash_insufficient',
  /** The payment path refused; the approval is spent, ask again. */
  'payment_refused',
  'recovery_unavailable',
] as const;
export type RecoveryRefusalReason = (typeof RECOVERY_REFUSAL_REASONS)[number];

export interface RecoveryRefusal {
  kind: 'refused';
  reason: RecoveryRefusalReason;
}

export type RecoveryListHeldResponse = RecoveryHeldView | RecoveryRefusal;
export type RecoveryCompleteAttemptResponse =
  | { kind: 'completed'; change_due_minor: number }
  | RecoveryRefusal;
export type RecoveryCancelAttemptResponse = { kind: 'cancelled' } | RecoveryRefusal;
export type RecoveryCancelHeldCartResponse = { kind: 'cancelled' } | RecoveryRefusal;

export interface RecoveryBridgeAPI {
  listHeld(): Promise<RecoveryListHeldResponse>;
  completeAttempt(req: RecoveryCompleteAttemptRequest): Promise<RecoveryCompleteAttemptResponse>;
  cancelAttempt(req: RecoveryCancelAttemptRequest): Promise<RecoveryCancelAttemptResponse>;
  cancelHeldCart(req: RecoveryCancelHeldCartRequest): Promise<RecoveryCancelHeldCartResponse>;
}
