import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react';

import type { ManagerActionKind } from '../../../shared/operator/manager-action-kinds';
import type { ManagerApprover } from '../../../shared/operator/manager-approval';
import type { RecoveryStuckAttemptView } from '../../../shared/operator/recovery';
import { MANAGER_PIN_PATTERN } from '../../../shared/shift-cashup/types';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { Dialog } from '../foundation/Dialog';
import { dismissUnlessBusy, useSingleFlight } from '../shift/shift-bridge';
import { ShiftAlert } from '../shift/ShiftScreen';
import { normalizeDigits } from '../shift/shift-format';
import {
  NO_EXTRAS,
  RECOVERY_ACTION_KIND,
  RECOVERY_ACTION_TITLE,
  performRecoveryAction,
  recoveryExtrasReady,
  recoverySubjectOf,
  type RecoveryAction,
  type RecoveryExtras,
} from './recovery-actions';
import { RECOVERY_COPY, recoveryRefusalMessage } from './recovery-copy';
import type { RecoveryBridges } from './RecoveryScreen';
import '../sale/live-sale.css';

export type { RecoveryAction } from './recovery-actions';

interface Props {
  action: RecoveryAction;
  bridges: RecoveryBridges;
  onDismiss: () => void;
  /** The action succeeded; the message says what happened. */
  onDone: (message: string) => void;
}

/**
 * The signed-in manager as the approver of `kind`. A refused read keeps its
 * reason (a locked or ended session is not "you have no PIN").
 */
type Approver =
  | { kind: 'loading' }
  | { kind: 'ready'; approver: ManagerApprover | null }
  | { kind: 'refused'; message: string };

function useRecoveryApprover(bridges: RecoveryBridges, kind: ManagerActionKind): Approver {
  const [state, setState] = useState<Approver>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    const settle = (next: Approver): void => {
      if (live) setState(next);
    };
    bridges.approval.listApprovers({ action_kind: kind }).then(
      (answer) => {
        settle(
          answer.kind === 'approvers'
            ? { kind: 'ready', approver: answer.approvers[0] ?? null }
            : { kind: 'refused', message: recoveryRefusalMessage(answer.reason) },
        );
      },
      () => {
        settle({ kind: 'refused', message: RECOVERY_COPY.unavailable });
      },
    );
    return () => {
      live = false;
    };
  }, [bridges, kind]);
  return state;
}

/**
 * Ask main for an approval of this exact action with the manager's PIN, then
 * spend it on the action. A refused approval never reaches the action.
 */
function useRecoverySubmit(props: Props): {
  busy: boolean;
  error: string | null;
  submit: (approver: ManagerApprover, pin: string, extras: RecoveryExtras) => void;
} {
  const { busy, run } = useSingleFlight();
  const [error, setError] = useState<string | null>(null);
  const submit = (approver: ManagerApprover, pin: string, extras: RecoveryExtras): void => {
    setError(null);
    run(async () => {
      try {
        const granted = await props.bridges.approval.request({
          action_kind: RECOVERY_ACTION_KIND[props.action.kind],
          subject_ref: recoverySubjectOf(props.action),
          reason_code: 'manager_recovery',
          approver_ref: approver.approver_ref,
          pin,
        });
        if (granted.kind !== 'approved') {
          setError(recoveryRefusalMessage(granted.reason));
          return;
        }
        const { recovery } = props.bridges;
        const result = await performRecoveryAction(
          recovery,
          props.action,
          granted.approval_id,
          extras,
        );
        if (result.ok) props.onDone(result.message);
        else setError(recoveryRefusalMessage(result.reason));
      } catch {
        setError(RECOVERY_COPY.unavailable);
      }
    });
  };
  return { busy, error, submit };
}

function CashField(
  props: Readonly<{
    stuck: RecoveryStuckAttemptView;
    value: string;
    onChange: (value: string) => void;
  }>,
): JSX.Element {
  const cashId = useId();
  return (
    <div className="v5-shift-fields">
      <p>
        {RECOVERY_COPY.remaining}:{' '}
        <bdi className="v5-shift-money">{formatCheckoutMoney(props.stuck.remaining_minor)}</bdi>
      </p>
      <label htmlFor={cashId}>{RECOVERY_COPY.cashReceived}</label>
      <input
        id={cashId}
        className="v5-shift-input v5-ltr"
        inputMode="decimal"
        autoComplete="off"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
    </div>
  );
}

function Confirm(
  props: Readonly<{
    checked: boolean;
    onChange: (checked: boolean) => void;
    children: ReactNode;
  }>,
): JSX.Element {
  return (
    <label>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onChange(event.target.checked);
        }}
      />
      {/* One flex item: the label's gap must not split the text around the amount. */}
      <span>{props.children}</span>
    </label>
  );
}

/** §5.2: live cash and card tender each need their confirmation first. */
function TenderConfirms(
  props: Readonly<{
    stuck: RecoveryStuckAttemptView;
    extras: RecoveryExtras;
    onChange: (extras: RecoveryExtras) => void;
  }>,
): JSX.Element {
  const { stuck, extras } = props;
  return (
    <fieldset className="v5-recovery-confirms">
      {stuck.cash_minor > 0 && (
        <Confirm
          checked={extras.cashReturned}
          onChange={(cashReturned) => {
            props.onChange({ ...extras, cashReturned });
          }}
        >
          {RECOVERY_COPY.confirmCash} (<bdi>{formatCheckoutMoney(stuck.cash_minor)}</bdi>)
        </Confirm>
      )}
      {stuck.card_minor > 0 && (
        <Confirm
          checked={extras.cardVoided}
          onChange={(cardVoided) => {
            props.onChange({ ...extras, cardVoided });
          }}
        >
          {RECOVERY_COPY.confirmCard}
        </Confirm>
      )}
    </fieldset>
  );
}

function ActionExtras(
  props: Readonly<{
    action: RecoveryAction;
    extras: RecoveryExtras;
    onChange: (extras: RecoveryExtras) => void;
  }>,
): JSX.Element | null {
  const { action, extras } = props;
  if (action.kind === 'complete' && action.stuck.remaining_minor > 0) {
    return (
      <CashField
        stuck={action.stuck}
        value={extras.cash}
        onChange={(cash) => {
          props.onChange({ ...extras, cash });
        }}
      />
    );
  }
  if (action.kind === 'cancel_attempt') {
    return <TenderConfirms stuck={action.stuck} extras={extras} onChange={props.onChange} />;
  }
  return null;
}

/** The manager's own PIN: masked, held only until the press, never stored or logged. */
function PinField(
  props: Readonly<{
    approver: ManagerApprover;
    value: string;
    onChange: (value: string) => void;
  }>,
): JSX.Element {
  const pinId = useId();
  return (
    <div className="v5-shift-fields">
      <p>{RECOVERY_COPY.approvalBody}</p>
      <label htmlFor={pinId}>
        {RECOVERY_COPY.pinLabel} — <bdi>{props.approver.display_name}</bdi>
      </label>
      <input
        id={pinId}
        className="v5-shift-input v5-ltr"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={8}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
    </div>
  );
}

function ApproverState({ state }: Readonly<{ state: Approver }>): JSX.Element | null {
  if (state.kind === 'loading') return <output>{RECOVERY_COPY.loading}</output>;
  if (state.kind === 'refused') return <ShiftAlert message={state.message} />;
  if (state.approver === null) return <ShiftAlert message={RECOVERY_COPY.noPin} />;
  return null;
}

/**
 * RT-441 — one recovery action, confirmed with the signed-in manager's own
 * PIN (RT-114: an approval bound to this subject and its amount, consumed by
 * the action in main).
 */
export function RecoveryActionDialog(props: Readonly<Props>): JSX.Element {
  const { action } = props;
  const state = useRecoveryApprover(props.bridges, RECOVERY_ACTION_KIND[action.kind]);
  const { busy, error, submit } = useRecoverySubmit(props);
  const backRef = useRef<HTMLButtonElement>(null);
  const [pin, setPin] = useState('');
  const [extras, setExtras] = useState<RecoveryExtras>(NO_EXTRAS);
  const approver = state.kind === 'ready' ? state.approver : null;
  const pinValid = MANAGER_PIN_PATTERN.test(normalizeDigits(pin));
  const ready = approver !== null && pinValid && recoveryExtrasReady(action, extras);
  const dismiss = dismissUnlessBusy(busy, props.onDismiss);
  const title = RECOVERY_ACTION_TITLE[action.kind];

  const press = (): void => {
    if (approver === null) return;
    const managerPin = normalizeDigits(pin);
    setPin('');
    submit(approver, managerPin, extras);
  };

  return (
    <Dialog label={title} onCancel={dismiss} initialFocusRef={backRef}>
      <h2 className="v5-live-dialog-title">{title}</h2>
      <ActionExtras action={action} extras={extras} onChange={setExtras} />
      <ApproverState state={state} />
      {approver !== null && <PinField approver={approver} value={pin} onChange={setPin} />}
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
          onClick={press}
        >
          {RECOVERY_COPY.approve}
        </button>
      </div>
    </Dialog>
  );
}
