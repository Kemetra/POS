import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { ManagerApprover } from '../../../shared/operator/manager-approval';
import type { SaleVoidJournalView, SaleVoidSaleView } from '../../../shared/sale-void/types';
import { MANAGER_PIN_PATTERN } from '../../../shared/shift-cashup/types';
import { Dialog } from '../foundation/Dialog';
import { dismissUnlessBusy, useSingleFlight } from '../shift/shift-bridge';
import { normalizeDigits } from '../shift/shift-format';
import { VOID_COPY, voidRefusalMessage } from './void-copy';
import type { VoidBridges } from './void-bridges';
import { VoidAlert, VoidCode, VoidMoney } from './void-parts';
import './void.css';

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
  if (approvers.kind === 'refused') return <VoidAlert message={approvers.message} />;
  if (approvers.approvers.length === 0) return <p>{VOID_COPY.noManagers}</p>;
  return (
    <fieldset className="v5-void-choices">
      <legend>{VOID_COPY.managerLegend}</legend>
      {approvers.approvers.map((manager) => (
        <label key={manager.approver_ref} className="v5-void-choice">
          <input
            type="radio"
            name={props.name}
            checked={props.selected === manager.approver_ref}
            onChange={() => {
              props.onSelect(manager.approver_ref);
            }}
          />
          <bdi>{manager.display_name}</bdi>
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
 *
 * RT-654 — on the V5 Dialog as drawn in VD-Void: the sale as a summary band
 * (number and amount, two LTR runs), 44px manager lines, the refusal in an
 * always-mounted slot, and «تأكيد الإلغاء» as the danger commit (OD-2). Focus
 * opens on «رجوع», the safe control.
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

  // After a refusal the commit is disabled (empty PIN), so focus would fall out of
  // the dialog: it goes to «رجوع», as VD-Void DialogRefused draws it.
  useEffect(() => {
    if (!busy && error !== null) backRef.current?.focus();
  }, [busy, error]);

  const press = (): void => {
    if (approver === null) return;
    const managerPin = normalizeDigits(pin);
    setPin('');
    submit(approver, managerPin);
  };

  return (
    <Dialog label={VOID_COPY.dialogTitle} onCancel={dismiss} initialFocusRef={backRef}>
      <h2 className="v5-void-dialog-title">{VOID_COPY.dialogTitle}</h2>
      <p className="v5-void-summary">
        <VoidCode value={props.sale.sale_number} />
        <VoidMoney minor={props.sale.total_minor} />
      </p>
      <p>{VOID_COPY.dialogBody}</p>
      <form
        className="v5-void-form"
        noValidate
        onSubmit={(event) => {
          // The commit is a press on «تأكيد الإلغاء» only, as before: Enter never sends.
          event.preventDefault();
        }}
      >
        <ManagerChoice
          approvers={approvers}
          name={groupName}
          selected={selected}
          onSelect={setSelected}
        />
        <div className="v5-void-field">
          <label htmlFor={pinId}>{VOID_COPY.pinLabel}</label>
          <input
            id={pinId}
            className="v5-void-input v5-void-input--pin"
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
        <div className="v5-void-slot">{error !== null && <VoidAlert message={error} />}</div>
        <div className="v5-void-dialog-actions">
          <button
            ref={backRef}
            type="button"
            className="v5-void-btn v5-btn"
            disabled={busy}
            onClick={dismiss}
          >
            {VOID_COPY.back}
          </button>
          <button
            type="button"
            className="v5-void-btn v5-void-btn--danger v5-btn v5-btn--danger"
            disabled={!ready || busy}
            onClick={press}
          >
            {VOID_COPY.approve}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
