import type {
  CashierPinStatus,
  ProvisionCashierPinResponse,
  ResetCashierPinResponse,
  UnlockCashierResponse,
} from '../../../shared/bridge-api';
import type { OperatorRefusal } from '../../../shared/audit/event-shape';
import { SIGN_IN_REFUSAL_COPY } from '../../ui/operator/messages';
import type { RowAction } from './cashiers-model';
import type { PinSaveResult } from './PinDialog';

/**
 * RT-424 (doc 19 §3, §5) — what each bridge answer means on Manager → Cashiers.
 * Refusal categories never reach the DOM; each maps to fixed copy (UX-12).
 */

/** The screen-level message after an action. */
export type Outcome =
  | { kind: 'done'; action: RowAction; name: string }
  | { kind: 'failure' }
  | { kind: 'after_reauth'; message: string }
  /** M6: provision found the manager's sign-in expired; the PIN waits for one retry. */
  | { kind: 'reauth'; cashier: CashierPinStatus; pin: string; dialogOpen: boolean };

/** A Save's result: what the dialog does, and the screen message when it closes. */
export interface SaveAnswer {
  dialog: PinSaveResult;
  outcome: Outcome | null;
}

type Answer<T> = T | OperatorRefusal;

export function firstPinAnswer(
  res: Answer<ProvisionCashierPinResponse>,
  cashier: CashierPinStatus,
  pin: string,
): SaveAnswer {
  if (res.kind === 'pin_provisioned') {
    return { dialog: 'closed', outcome: done('first_pin', cashier) };
  }
  if (res.category === 'reauth_required') {
    return { dialog: 'closed', outcome: { kind: 'reauth', cashier, pin, dialogOpen: false } };
  }
  return { dialog: res.category === 'not_ready' ? 'not_ready' : 'failure', outcome: null };
}

export function changePinAnswer(
  res: Answer<ResetCashierPinResponse>,
  cashier: CashierPinStatus,
): SaveAnswer {
  if (res.kind === 'pin_reset') return { dialog: 'closed', outcome: done('change_pin', cashier) };
  return { dialog: 'failure', outcome: null };
}

/**
 * RT-358 — the one retry after a re-auth. A refusal never prompts again: it
 * uses the sign-in refusal copy, and `reauth_required` reads as signed out
 * (main fails closed on the marked retry).
 */
export function afterReauthAnswer(
  res: Answer<ProvisionCashierPinResponse>,
  cashier: CashierPinStatus,
): Outcome {
  if (res.kind === 'pin_provisioned') return done('first_pin', cashier);
  const category = res.category === 'reauth_required' ? 'not_signed_in' : res.category;
  return { kind: 'after_reauth', message: SIGN_IN_REFUSAL_COPY[category] };
}

/**
 * An unlock that finds the lock already ended answers `state_invalid`; that
 * keeps today's behaviour and counts as unlocked (doc 19 §2), then the list
 * re-reads.
 */
export function unlockAnswer(
  res: Answer<UnlockCashierResponse>,
  cashier: CashierPinStatus,
): Outcome {
  const unlocked = res.kind === 'unlocked' || res.category === 'state_invalid';
  return unlocked ? done('unlock', cashier) : { kind: 'failure' };
}

function done(action: RowAction, cashier: CashierPinStatus): Outcome {
  return { kind: 'done', action, name: cashier.display_name };
}
