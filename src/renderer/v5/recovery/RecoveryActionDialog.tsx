import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { ManagerActionKind } from '../../../shared/operator/manager-action-kinds';
import type { ManagerApprover } from '../../../shared/operator/manager-approval';
import type {
  RecoveryHeldCartView,
  RecoveryStuckAttemptView,
} from '../../../shared/operator/recovery';
import { MANAGER_PIN_PATTERN } from '../../../shared/shift-cashup/types';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { parseCurrencyToMinor } from '../../ui/payments/parse-currency-to-minor';
import { Dialog } from '../foundation/Dialog';
import { ShiftAlert } from '../shift/ShiftScreen';
import { normalizeDigits } from '../shift/shift-format';
import { RECOVERY_COPY, recoveryRefusalMessage } from './recovery-copy';
import type { RecoveryBridges } from './RecoveryScreen';
import '../sale/live-sale.css';

export type RecoveryAction =
  | { kind: 'complete'; stuck: RecoveryStuckAttemptView }
  | { kind: 'cancel_attempt'; stuck: RecoveryStuckAttemptView }
  | { kind: 'cancel_cart'; cart: RecoveryHeldCartView };

interface Props {
  action: RecoveryAction;
  bridges: RecoveryBridges;
  onDismiss: () => void;
  /** The action succeeded; the message says what happened. */
  onDone: (message: string) => void;
}

const KIND: Record<RecoveryAction['kind'], ManagerActionKind> = {
  complete: 'recovery.complete_attempt',
  cancel_attempt: 'recovery.cancel_attempt',
  cancel_cart: 'recovery.cancel_held_cart',
};

const TITLE: Record<RecoveryAction['kind'], string> = {
  complete: RECOVERY_COPY.complete,
  cancel_attempt: RECOVERY_COPY.cancelPayment,
  cancel_cart: RECOVERY_COPY.cancelSale,
};

function subjectOf(action: RecoveryAction): string {
  return action.kind === 'cancel_cart' ? action.cart.cart_id : action.stuck.payment_attempt_id;
}

type Approver = { kind: 'loading' } | { kind: 'ready'; approver: ManagerApprover | null };

function useSelf(bridges: RecoveryBridges, kind: ManagerActionKind): Approver {
  const [state, setState] = useState<Approver>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    bridges.approval.listApprovers({ action_kind: kind }).then(
      (answer) => {
        if (!live) return;
        setState({
          kind: 'ready',
          approver: answer.kind === 'approvers' ? (answer.approvers[0] ?? null) : null,
        });
      },
      () => {
        if (live) setState({ kind: 'ready', approver: null });
      },
    );
    return () => {
      live = false;
    };
  }, [bridges, kind]);
  return state;
}

/** What the action itself needs besides the approval: cash, or confirmations. */
interface Extras {
  cash: string;
  cashReturned: boolean;
  cardVoided: boolean;
}

function extrasReady(action: RecoveryAction, extras: Extras): boolean {
  if (action.kind === 'complete') {
    const { remaining_minor } = action.stuck;
    if (remaining_minor === 0) return true;
    const cash = parseCurrencyToMinor(normalizeDigits(extras.cash));
    return cash !== null && cash >= remaining_minor;
  }
  if (action.kind === 'cancel_attempt') {
    const { cash_minor, card_minor } = action.stuck;
    return (cash_minor === 0 || extras.cashReturned) && (card_minor === 0 || extras.cardVoided);
  }
  return true;
}

async function perform(
  props: Props,
  approval_id: string,
  extras: Extras,
): Promise<{ ok: true; message: string } | { ok: false; reason: string }> {
  const { action, bridges } = props;
  if (action.kind === 'complete') {
    const parsed = parseCurrencyToMinor(normalizeDigits(extras.cash));
    const cash = action.stuck.remaining_minor > 0 && parsed !== null ? parsed : undefined;
    const answer = await bridges.recovery.completeAttempt({
      payment_attempt_id: action.stuck.payment_attempt_id,
      approval_id,
      ...(cash === undefined ? {} : { cash_received_minor: cash }),
    });
    if (answer.kind !== 'completed') return { ok: false, reason: answer.reason };
    const change =
      answer.change_due_minor > 0
        ? ` ${RECOVERY_COPY.change}: ${formatCheckoutMoney(answer.change_due_minor)}`
        : '';
    return { ok: true, message: `${RECOVERY_COPY.completed}${change}` };
  }
  if (action.kind === 'cancel_attempt') {
    const answer = await bridges.recovery.cancelAttempt({
      payment_attempt_id: action.stuck.payment_attempt_id,
      approval_id,
      ...(action.stuck.cash_minor > 0 ? { cash_returned_confirmed: extras.cashReturned } : {}),
      ...(action.stuck.card_minor > 0
        ? { card_void_confirmed_on_terminal: extras.cardVoided }
        : {}),
    });
    return answer.kind === 'cancelled'
      ? { ok: true, message: RECOVERY_COPY.cancelledPayment }
      : { ok: false, reason: answer.reason };
  }
  const answer = await bridges.recovery.cancelHeldCart({
    cart_id: action.cart.cart_id,
    approval_id,
  });
  return answer.kind === 'cancelled'
    ? { ok: true, message: RECOVERY_COPY.cancelledSale }
    : { ok: false, reason: answer.reason };
}

/**
 * RT-441 — one recovery action, confirmed with the signed-in manager's own
 * PIN (RT-114: an approval bound to this subject and its amount, consumed by
 * the action in main). The PIN is masked, held only until the press, then
 * cleared; it is never stored or logged.
 */
export function RecoveryActionDialog(props: Props): JSX.Element {
  const { action } = props;
  const kind = KIND[action.kind];
  const self = useSelf(props.bridges, kind);
  const pinId = useId();
  const cashId = useId();
  const backRef = useRef<HTMLButtonElement>(null);
  const [pin, setPin] = useState('');
  const [extras, setExtras] = useState<Extras>({
    cash: '',
    cashReturned: false,
    cardVoided: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const approver = self.kind === 'ready' ? self.approver : null;
  const ready =
    approver !== null &&
    MANAGER_PIN_PATTERN.test(normalizeDigits(pin)) &&
    extrasReady(action, extras);

  const dismiss = (): void => {
    if (!busy) props.onDismiss();
  };

  const submit = async (): Promise<void> => {
    if (approver === null || busy) return;
    const managerPin = normalizeDigits(pin);
    setPin('');
    setError(null);
    setBusy(true);
    try {
      const granted = await props.bridges.approval.request({
        action_kind: kind,
        subject_ref: subjectOf(action),
        reason_code: 'manager_recovery',
        approver_ref: approver.approver_ref,
        pin: managerPin,
      });
      if (granted.kind !== 'approved') {
        setError(recoveryRefusalMessage(granted.reason));
        return;
      }
      const result = await perform(props, granted.approval_id, extras);
      if (result.ok) props.onDone(result.message);
      else setError(recoveryRefusalMessage(result.reason));
    } catch {
      setError(RECOVERY_COPY.unavailable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog label={TITLE[action.kind]} onCancel={dismiss} initialFocusRef={backRef}>
      <h2 className="v5-live-dialog-title">{TITLE[action.kind]}</h2>
      {action.kind === 'complete' && action.stuck.remaining_minor > 0 && (
        <div className="v5-shift-fields">
          <p>
            {RECOVERY_COPY.remaining}:{' '}
            <bdi className="v5-shift-money">
              {formatCheckoutMoney(action.stuck.remaining_minor)}
            </bdi>
          </p>
          <label htmlFor={cashId}>{RECOVERY_COPY.cashReceived}</label>
          <input
            id={cashId}
            className="v5-shift-input v5-ltr"
            inputMode="decimal"
            autoComplete="off"
            value={extras.cash}
            onChange={(event) => {
              setExtras({ ...extras, cash: event.target.value });
            }}
          />
        </div>
      )}
      {action.kind === 'cancel_attempt' && (
        <fieldset className="v5-recovery-confirms">
          {action.stuck.cash_minor > 0 && (
            <label>
              <input
                type="checkbox"
                checked={extras.cashReturned}
                onChange={(event) => {
                  setExtras({ ...extras, cashReturned: event.target.checked });
                }}
              />
              {RECOVERY_COPY.confirmCash} (<bdi>{formatCheckoutMoney(action.stuck.cash_minor)}</bdi>
              )
            </label>
          )}
          {action.stuck.card_minor > 0 && (
            <label>
              <input
                type="checkbox"
                checked={extras.cardVoided}
                onChange={(event) => {
                  setExtras({ ...extras, cardVoided: event.target.checked });
                }}
              />
              {RECOVERY_COPY.confirmCard}
            </label>
          )}
        </fieldset>
      )}
      {self.kind === 'loading' && <p role="status">{RECOVERY_COPY.loading}</p>}
      {self.kind === 'ready' && approver === null && <ShiftAlert message={RECOVERY_COPY.noPin} />}
      {approver !== null && (
        <div className="v5-shift-fields">
          <p>{RECOVERY_COPY.approvalBody}</p>
          <label htmlFor={pinId}>
            {RECOVERY_COPY.pinLabel} — <bdi>{approver.display_name}</bdi>
          </label>
          <input
            id={pinId}
            className="v5-shift-input v5-ltr"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(event) => {
              setPin(event.target.value);
            }}
          />
        </div>
      )}
      <ShiftAlert message={error} />
      <div>
        <button
          ref={backRef}
          type="button"
          className="v5-live-btn"
          disabled={busy}
          onClick={dismiss}
        >
          {RECOVERY_COPY.back}
        </button>
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary"
          disabled={!ready || busy}
          onClick={() => void submit()}
        >
          {RECOVERY_COPY.approve}
        </button>
      </div>
    </Dialog>
  );
}
