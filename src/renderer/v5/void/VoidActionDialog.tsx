import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { ManagerApprover } from '../../../shared/operator/manager-approval';
import type { SaleVoidJournalView, SaleVoidSaleView } from '../../../shared/sale-void/types';
import { MANAGER_PIN_PATTERN } from '../../../shared/shift-cashup/types';
import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { Dialog } from '../foundation/Dialog';
import { dismissUnlessBusy, useSingleFlight } from '../shift/shift-bridge';
import { normalizeDigits } from '../shift/shift-format';
import { ShiftAlert } from '../shift/ShiftScreen';
import { VOID_COPY, voidRefusalMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import '../sale/live-sale.css';

interface Props {
  readonly sale: SaleVoidSaleView;
  readonly bridges: VoidBridges;
  readonly onDismiss: () => void;
  /** The void was journaled; the row says what it waits for. */
  readonly onRequested: (entry: SaleVoidJournalView) => void;
}

type Approvers =
  | { kind: 'loading' }
  | { kind: 'ready'; approvers: ManagerApprover[] }
  | { kind: 'refused'; message: string };

/** The managers enrolled on this terminal who may approve a sale void. */
function useApprovers(bridges: VoidBridges): Approvers {
  const [state, setState] = useState<Approvers>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    const settle = (next: Approvers): void => {
      if (live) setState(next);
    };
    bridges.approval.listApprovers({ action_kind: 'sale.void' }).then(
      (answer) => {
        settle(
          answer.kind === 'approvers'
            ? { kind: 'ready', approvers: answer.approvers }
            : { kind: 'refused', message: voidRefusalMessage(answer.reason) },
        );
      },
      () => {
        settle({ kind: 'refused', message: VOID_COPY.unavailable });
      },
    );
    return () => {
      live = false;
    };
  }, [bridges]);
  return state;
}

/**
 * Ask main for an approval of THIS sale with the manager's PIN, then spend it
 * on the void. A refused approval never reaches the void request, and the PIN
 * is cleared on the press (never stored, never logged).
 */
function useVoidSubmit(props: Props): {
  busy: boolean;
  error: string | null;
  submit: (approver: ManagerApprover, pin: string) => void;
} {
  const { busy, run } = useSingleFlight();
  const [error, setError] = useState<string | null>(null);
  const submit = (approver: ManagerApprover, pin: string): void => {
    setError(null);
    run(async () => {
      try {
        const granted = await props.bridges.approval.request({
          action_kind: 'sale.void',
          subject_ref: props.sale.sale_id,
          reason_code: 'sale_void',
          approver_ref: approver.approver_ref,
          pin,
        });
        if (granted.kind !== 'approved') {
          setError(voidRefusalMessage(granted.reason));
          return;
        }
        const answer = await props.bridges.saleVoid.request({
          sale_id: props.sale.sale_id,
          approval_id: granted.approval_id,
        });
        if (answer.kind === 'requested') props.onRequested(answer.void);
        else setError(voidRefusalMessage(answer.reason));
      } catch {
        setError(VOID_COPY.unavailable);
      }
    });
  };
  return { busy, error, submit };
}

function ManagerChoice(props: {
  approvers: Approvers;
  name: string;
  selected: string | null;
  onSelect: (ref: string) => void;
}): JSX.Element {
  const { approvers } = props;
  if (approvers.kind === 'loading') return <output>{VOID_COPY.loading}</output>;
  if (approvers.kind === 'refused') return <ShiftAlert message={approvers.message} />;
  if (approvers.approvers.length === 0) return <p>{VOID_COPY.noManagers}</p>;
  return (
    <fieldset className="v5-shift-managers">
      <legend>{VOID_COPY.managerLegend}</legend>
      {approvers.approvers.map((manager) => (
        <label key={manager.approver_ref} className="v5-shift-manager">
          <input
            type="radio"
            name={props.name}
            checked={props.selected === manager.approver_ref}
            onChange={() => {
              props.onSelect(manager.approver_ref);
            }}
          />
          {manager.display_name}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * RT-530 — void one finalized sale, confirmed with ANOTHER manager's PIN
 * (RT-114: an approval bound to this sale, its total and the requester, spent
 * by the void request in main). The manager picks their name from the
 * terminal's enrolled managers (opaque handles) and types a masked PIN.
 */
export function VoidActionDialog(props: Props): JSX.Element {
  const pinId = useId();
  const groupName = useId();
  const backRef = useRef<HTMLButtonElement>(null);
  const approvers = useApprovers(props.bridges);
  const { busy, error, submit } = useVoidSubmit(props);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const dismiss = dismissUnlessBusy(busy, props.onDismiss);
  const approver =
    approvers.kind === 'ready'
      ? (approvers.approvers.find((a) => a.approver_ref === selected) ?? null)
      : null;
  const ready = approver !== null && MANAGER_PIN_PATTERN.test(normalizeDigits(pin));

  const press = (): void => {
    if (approver === null) return;
    const managerPin = normalizeDigits(pin);
    setPin('');
    submit(approver, managerPin);
  };

  return (
    <Dialog label={VOID_COPY.dialogTitle} onCancel={dismiss} initialFocusRef={backRef}>
      <h2 className="v5-live-dialog-title">{VOID_COPY.dialogTitle}</h2>
      <p>
        {props.sale.sale_number} — <bdi>{formatCheckoutMoney(props.sale.total_minor)}</bdi>
      </p>
      <p>{VOID_COPY.dialogBody}</p>
      <ManagerChoice
        approvers={approvers}
        name={groupName}
        selected={selected}
        onSelect={setSelected}
      />
      <div className="v5-shift-fields">
        <label htmlFor={pinId}>{VOID_COPY.pinLabel}</label>
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
      <ShiftAlert message={error} />
      <div>
        <button
          ref={backRef}
          type="button"
          className="v5-live-btn"
          disabled={busy}
          onClick={dismiss}
        >
          {VOID_COPY.back}
        </button>
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary"
          disabled={!ready || busy}
          onClick={press}
        >
          {VOID_COPY.approve}
        </button>
      </div>
    </Dialog>
  );
}
