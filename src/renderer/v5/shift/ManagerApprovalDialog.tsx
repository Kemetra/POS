import { useEffect, useId, useRef, useState, type JSX } from 'react';

import {
  MANAGER_PIN_PATTERN,
  type ShiftCashupBridgeAPI,
  type ShiftCloseResponse,
  type ShiftEnrolledManager,
} from '../../../shared/shift-cashup/types';
import { SaleDialog } from '../sale/SaleDialog';
import { callShift, useSingleFlight } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { normalizeDigits } from './shift-format';
import { ShiftAlert } from './ShiftScreen';
import '../sale/live-sale.css';

type Closed = Extract<ShiftCloseResponse, { kind: 'closed' }>;

interface Props {
  readonly bridge: ShiftCashupBridgeAPI;
  /** The blind count the approval is for (the close is retried with it). */
  readonly countedCashMinor: number;
  readonly onDismiss: () => void;
  readonly onClosed: (answer: Closed) => void;
  /** The drawer moved during the approval: the cashier counts again. */
  readonly onStale: () => void;
}

type Managers =
  | { kind: 'loading' }
  | { kind: 'managers'; managers: ShiftEnrolledManager[] }
  | { kind: 'refused'; message: string };

function useEnrolledManagers(bridge: ShiftCashupBridgeAPI): Managers {
  const [managers, setManagers] = useState<Managers>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void callShift(() => bridge.listEnrolledManagers()).then((answer) => {
      if (!live) return;
      setManagers(
        answer.kind === 'managers'
          ? answer
          : { kind: 'refused', message: shiftRefusalMessage(answer.reason) },
      );
    });
    return () => {
      live = false;
    };
  }, [bridge]);
  return managers;
}

/**
 * RT-17 slice 4 part 3 — the manager approval of a non-zero variance, inside
 * the cashier's session (DESIGN.md: the approval sheet authenticates the
 * manager without replacing the session). The manager picks their name from
 * the terminal's enrolled managers (opaque handles; never a users.id) and
 * types their PIN — masked, held only until the press, then cleared, never
 * stored or logged. The close is retried with the same count.
 */
export function ManagerApprovalDialog(props: Props): JSX.Element {
  const pinId = useId();
  const groupName = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const managers = useEnrolledManagers(props.bridge);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();
  const ready = selected !== null && MANAGER_PIN_PATTERN.test(normalizeDigits(pin));

  const submit = (): void => {
    if (selected === null) return;
    const managerPin = normalizeDigits(pin);
    setPin('');
    setError(null);
    run(async () => {
      const approver = { managerRef: selected, managerPin };
      const { countedCashMinor } = props;
      const answer = await callShift(() => props.bridge.close({ countedCashMinor, approver }));
      if (answer.kind === 'closed') props.onClosed(answer);
      else if (answer.reason === 'approval_stale') props.onStale();
      else setError(shiftRefusalMessage(answer.reason));
    });
  };

  return (
    <SaleDialog
      label={SHIFT_COPY.approvalTitle}
      onDismiss={props.onDismiss}
      initialFocusRef={cancelRef}
    >
      <h2 className="v5-live-dialog-title">{SHIFT_COPY.approvalTitle}</h2>
      <p>{SHIFT_COPY.approvalBody}</p>
      <ManagerChoice
        managers={managers}
        name={groupName}
        selected={selected}
        onSelect={setSelected}
      />
      <div className="v5-shift-fields">
        <label htmlFor={pinId}>{SHIFT_COPY.pinLabel}</label>
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
        <button ref={cancelRef} type="button" className="v5-live-btn" onClick={props.onDismiss}>
          {SHIFT_COPY.cancel}
        </button>
        <button
          type="button"
          className="v5-live-btn v5-live-btn--primary"
          disabled={!ready || busy}
          onClick={submit}
        >
          {SHIFT_COPY.approveCommit}
        </button>
      </div>
    </SaleDialog>
  );
}

function ManagerChoice(props: {
  managers: Managers;
  name: string;
  selected: string | null;
  onSelect: (managerRef: string) => void;
}): JSX.Element {
  const { managers } = props;
  if (managers.kind === 'loading') return <p role="status">{SHIFT_COPY.loadingManagers}</p>;
  if (managers.kind === 'refused') return <ShiftAlert message={managers.message} />;
  if (managers.managers.length === 0) return <p>{SHIFT_COPY.noManagers}</p>;
  return (
    <fieldset className="v5-shift-managers">
      <legend>{SHIFT_COPY.managerLegend}</legend>
      {managers.managers.map((manager) => (
        <label key={manager.managerRef} className="v5-shift-manager">
          <input
            type="radio"
            name={props.name}
            checked={props.selected === manager.managerRef}
            onChange={() => {
              props.onSelect(manager.managerRef);
            }}
          />
          {manager.displayName}
        </label>
      ))}
    </fieldset>
  );
}
