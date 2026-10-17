import { useId, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import type { ShiftCashupBridgeAPI, ShiftCloseResponse } from '../../../shared/shift-cashup/types';
import { ManagerApprovalDialog } from './ManagerApprovalDialog';
import { callShift, useSingleFlight } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { parseShiftAmount } from './shift-format';
import { ShiftAlert } from './ShiftScreen';
import { PARKED_SALES_PATH } from '../park/ParkedSalesRoute';
import { PARK_COPY, terminalParkedCount } from '../park/park-copy';
import { V5Icon } from '../foundation/V5Icon';

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
  // RT-445 (K4 / OP-2, OD-13): parked sales block the close; how many, terminal-wide.
  const [parked, setParked] = useState<{ count: number | null } | null>(null);
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
    setParked(null);
    run(async () => {
      const answer = await callShift(() => props.bridge.close({ countedCashMinor }));
      if (answer.kind === 'closed') closed(answer);
      else if (answer.reason === 'variance_approval_required') setApproving(countedCashMinor);
      else if (answer.reason === 'parked_sales_present')
        setParked({ count: answer.parkedCount ?? null });
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
      {parked !== null && <ParkedSalesBlock count={parked.count} />}
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

/**
 * RT-445 (PK3-ShiftClose) — the close is refused while any parked sale exists
 * on this terminal (spec 024 K4). The line is `SHIFT_COPY` verbatim; the count
 * is terminal-wide and a count only (OD-13); the button opens the cashier's
 * own list.
 */
function ParkedSalesBlock({ count }: Readonly<{ count: number | null }>): JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="v5-park-shift-alert" role="alert" data-testid="shift-parked-block">
      <V5Icon name="status-warning" />
      <div className="v5-park-shift-alert__text">
        <p>{shiftRefusalMessage('parked_sales_present')}</p>
        {count !== null && (
          <p>
            <span className="v5-park-chip">{terminalParkedCount(count)}</span>
          </p>
        )}
        <p>
          <button
            type="button"
            className="v5-shift-btn"
            onClick={() => {
              void navigate(PARKED_SALES_PATH);
            }}
          >
            {PARK_COPY.showMyParked}
          </button>
        </p>
      </div>
    </div>
  );
}
