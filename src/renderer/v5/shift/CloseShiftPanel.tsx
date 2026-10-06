import { useId, useState, type JSX } from 'react';

import type { ShiftCashupBridgeAPI, ShiftCloseResponse } from '../../../shared/shift-cashup/types';
import { ManagerApprovalDialog } from './ManagerApprovalDialog';
import { callShift, useSingleFlight } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { parseShiftAmount } from './shift-format';
import { ShiftAlert } from './ShiftScreen';

/** A recorded close: its variance only when main returned one (an approved close). */
export interface ShiftClosed {
  readonly varianceMinor?: number;
  readonly currencyCode: string;
}

interface Props {
  readonly bridge: ShiftCashupBridgeAPI;
  readonly currencyCode: string;
  readonly onClosed: (closed: ShiftClosed) => void;
}

type Closed = Extract<ShiftCloseResponse, { kind: 'closed' }>;

/**
 * RT-17 slice 4 part 3 — the blind-count close (10920 decision 2). The panel
 * shows no amount at all: the cashier enters the counted cash, and main
 * answers the close with its id and time only. A count that does not match
 * is refused `variance_approval_required`; the manager approval step then
 * retries the same count with a listed manager and their PIN, and only that
 * approved close returns the variance (shown after the commit).
 */
export function CloseShiftPanel(props: Props): JSX.Element {
  const inputId = useId();
  const [count, setCount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<number | null>(null);
  const { busy, run } = useSingleFlight();

  const closed = (answer: Closed): void => {
    props.onClosed({
      currencyCode: props.currencyCode,
      ...(answer.varianceMinor === undefined ? {} : { varianceMinor: answer.varianceMinor }),
    });
  };

  const submit = (): void => {
    const countedCashMinor = parseShiftAmount(count);
    if (countedCashMinor === null) {
      setError(SHIFT_COPY.invalidAmount);
      return;
    }
    setError(null);
    run(async () => {
      const answer = await callShift(() => props.bridge.close({ countedCashMinor }));
      if (answer.kind === 'closed') closed(answer);
      else if (answer.reason === 'variance_approval_required') setApproving(countedCashMinor);
      else setError(shiftRefusalMessage(answer.reason));
    });
  };

  return (
    <div className="v5-shift-panel" data-testid="shift-close-panel">
      <h2>{SHIFT_COPY.closeHeading}</h2>
      <p className="v5-shift-hint">{SHIFT_COPY.blindHint}</p>
      <label htmlFor={inputId}>{SHIFT_COPY.countLabel}</label>
      <input
        id={inputId}
        className="v5-shift-input v5-ltr"
        inputMode="decimal"
        autoComplete="off"
        value={count}
        onChange={(event) => {
          setCount(event.target.value);
        }}
      />
      <ShiftAlert message={error} />
      <button
        type="button"
        className="v5-shift-btn v5-shift-btn--primary"
        disabled={busy || approving !== null}
        onClick={submit}
      >
        {SHIFT_COPY.closeCommit}
      </button>
      {approving !== null && (
        <ManagerApprovalDialog
          bridge={props.bridge}
          countedCashMinor={approving}
          onDismiss={() => {
            setApproving(null);
          }}
          onClosed={(answer) => {
            setApproving(null);
            closed(answer);
          }}
          onStale={() => {
            setApproving(null);
            setCount('');
            setError(shiftRefusalMessage('approval_stale'));
          }}
        />
      )}
    </div>
  );
}
