import type { ManagerActionKind } from '../../../shared/operator/manager-action-kinds';
import type {
  RecoveryBridgeAPI,
  RecoveryHeldCartView,
  RecoveryStuckAttemptView,
} from '../../../shared/operator/recovery';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { parseCurrencyToMinor } from '../../ui/payments/parse-currency-to-minor';
import { normalizeDigits } from '../shift/shift-format';
import { RECOVERY_COPY } from './recovery-copy';

/**
 * RT-441 (RT-116 §5.2) — the three manager recovery actions, without React:
 * which approval each consumes, what it needs besides the approval, and the
 * bridge call that spends the approval.
 */

export type RecoveryAction =
  | { kind: 'complete'; stuck: RecoveryStuckAttemptView }
  | { kind: 'cancel_attempt'; stuck: RecoveryStuckAttemptView }
  | { kind: 'cancel_cart'; cart: RecoveryHeldCartView };

export const RECOVERY_ACTION_KIND: Readonly<Record<RecoveryAction['kind'], ManagerActionKind>> =
  Object.freeze({
    complete: 'recovery.complete_attempt',
    cancel_attempt: 'recovery.cancel_attempt',
    cancel_cart: 'recovery.cancel_held_cart',
  });

export const RECOVERY_ACTION_TITLE: Readonly<Record<RecoveryAction['kind'], string>> =
  Object.freeze({
    complete: RECOVERY_COPY.complete,
    cancel_attempt: RECOVERY_COPY.cancelPayment,
    cancel_cart: RECOVERY_COPY.cancelSale,
  });

/** The approval's subject: the held cart, or the stuck payment attempt. */
export function recoverySubjectOf(action: RecoveryAction): string {
  return action.kind === 'cancel_cart' ? action.cart.cart_id : action.stuck.payment_attempt_id;
}

/** What the action itself needs besides the approval: cash, or confirmations. */
export interface RecoveryExtras {
  cash: string;
  cashReturned: boolean;
  cardVoided: boolean;
}

export const NO_EXTRAS: RecoveryExtras = Object.freeze({
  cash: '',
  cashReturned: false,
  cardVoided: false,
});

/** The cash typed for the remaining balance, in minor units, or null. */
function cashMinor(extras: RecoveryExtras): number | null {
  return parseCurrencyToMinor(normalizeDigits(extras.cash));
}

function cashCovers(stuck: RecoveryStuckAttemptView, extras: RecoveryExtras): boolean {
  if (stuck.remaining_minor === 0) return true;
  const cash = cashMinor(extras);
  return cash !== null && cash >= stuck.remaining_minor;
}

function tenderConfirmed(stuck: RecoveryStuckAttemptView, extras: RecoveryExtras): boolean {
  const cashOk = stuck.cash_minor === 0 || extras.cashReturned;
  const cardOk = stuck.card_minor === 0 || extras.cardVoided;
  return cashOk && cardOk;
}

export function recoveryExtrasReady(action: RecoveryAction, extras: RecoveryExtras): boolean {
  if (action.kind === 'complete') return cashCovers(action.stuck, extras);
  if (action.kind === 'cancel_attempt') return tenderConfirmed(action.stuck, extras);
  return true;
}

export type RecoveryOutcome = { ok: true; message: string } | { ok: false; reason: string };

function changeNote(changeDueMinor: number): string {
  return changeDueMinor > 0
    ? ` ${RECOVERY_COPY.change}: ${formatCheckoutMoney(changeDueMinor)}`
    : '';
}

async function completeAttempt(
  bridge: RecoveryBridgeAPI,
  stuck: RecoveryStuckAttemptView,
  approval_id: string,
  extras: RecoveryExtras,
): Promise<RecoveryOutcome> {
  // Cash is sent only when something remains; a fully tendered sale needs none.
  const cash = stuck.remaining_minor > 0 ? cashMinor(extras) : null;
  const answer = await bridge.completeAttempt({
    payment_attempt_id: stuck.payment_attempt_id,
    approval_id,
    ...(cash === null ? {} : { cash_received_minor: cash }),
  });
  if (answer.kind !== 'completed') return { ok: false, reason: answer.reason };
  return { ok: true, message: `${RECOVERY_COPY.completed}${changeNote(answer.change_due_minor)}` };
}

async function cancelAttempt(
  bridge: RecoveryBridgeAPI,
  stuck: RecoveryStuckAttemptView,
  approval_id: string,
  extras: RecoveryExtras,
): Promise<RecoveryOutcome> {
  // Each confirmation is sent only when its tender is live (§5.2).
  const answer = await bridge.cancelAttempt({
    payment_attempt_id: stuck.payment_attempt_id,
    approval_id,
    ...(stuck.cash_minor > 0 ? { cash_returned_confirmed: extras.cashReturned } : {}),
    ...(stuck.card_minor > 0 ? { card_void_confirmed_on_terminal: extras.cardVoided } : {}),
  });
  return answer.kind === 'cancelled'
    ? { ok: true, message: RECOVERY_COPY.cancelledPayment }
    : { ok: false, reason: answer.reason };
}

async function cancelHeldCart(
  bridge: RecoveryBridgeAPI,
  cart: RecoveryHeldCartView,
  approval_id: string,
): Promise<RecoveryOutcome> {
  const answer = await bridge.cancelHeldCart({ cart_id: cart.cart_id, approval_id });
  return answer.kind === 'cancelled'
    ? { ok: true, message: RECOVERY_COPY.cancelledSale }
    : { ok: false, reason: answer.reason };
}

/** Spend `approval_id` on the action. */
export function performRecoveryAction(
  bridge: RecoveryBridgeAPI,
  action: RecoveryAction,
  approval_id: string,
  extras: RecoveryExtras,
): Promise<RecoveryOutcome> {
  if (action.kind === 'complete') return completeAttempt(bridge, action.stuck, approval_id, extras);
  if (action.kind === 'cancel_attempt') {
    return cancelAttempt(bridge, action.stuck, approval_id, extras);
  }
  return cancelHeldCart(bridge, action.cart, approval_id);
}
