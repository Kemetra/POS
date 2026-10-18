import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';

import { isShiftAmountWithinBound } from '../../../shared/shift-cashup/amount-bound';
import type { ShiftCashupBridgeAPI, ShiftCloseResponse } from '../../../shared/shift-cashup/types';
import { ManagerApprovalDialog } from './ManagerApprovalDialog';
import { callShift, useSingleFlight } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { parseShiftAmount } from './shift-format';
import {
  amountOutOfRange,
  invalidEntry,
  refusalEntry,
  refusedCall,
  ShiftAmountField,
  ShiftCard,
  type FieldError,
} from './ShiftParts';
import { PARKED_SALES_PATH } from '../park/ParkedSalesRoute';
import { PARK_COPY, terminalParkedCount } from '../park/park-copy';
import { Icon } from '../../icons/Icon';

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
 * approved close returns the variance (shown after the commit). RT-278 S1: a
 * count above main's flat cap is not sent; the cap depends on nothing hidden,
 * so the pre-check reveals nothing about the expected cash.
 */
export function CloseShiftPanel(props: Props): JSX.Element {
  const [count, setCount] = useState('');
  const [error, setError] = useState<FieldError | null>(null);
  // RT-445 (K4 / OP-2, OD-13): parked sales block the close; how many, terminal-wide.
  const [parked, setParked] = useState<{ count: number | null } | null>(null);
  const [approving, setApproving] = useState<number | null>(null);
  const { busy, run } = useSingleFlight();
  const commitRef = useRef<HTMLButtonElement>(null);
  const countRef = useRef<HTMLInputElement>(null);
  useFocusBackAfterApproval(approving, commitRef);

  const closed = (answer: Closed): void => {
    props.onClosed({
      currencyCode: props.currencyCode,
      ...(answer.varianceMinor === undefined ? {} : { varianceMinor: answer.varianceMinor }),
    });
  };

  /** The amount itself is wrong: say so under the field and give it focus back. */
  const rejectAmount = (next: FieldError): void => {
    setError(next);
    countRef.current?.focus();
  };

  const submit = (): void => {
    const countedCashMinor = parseShiftAmount(count);
    if (countedCashMinor === null) {
      setError(invalidEntry(SHIFT_COPY.invalidAmount));
      return;
    }
    setParked(null);
    if (!isShiftAmountWithinBound('counted_cash', countedCashMinor, props.currencyCode)) {
      rejectAmount(amountOutOfRange());
      return;
    }
    setError(null);
    run(async () => {
      const answer = await callShift(() => props.bridge.close({ countedCashMinor }));
      if (answer.kind === 'closed') closed(answer);
      else if (answer.reason === 'variance_approval_required') setApproving(countedCashMinor);
      else if (answer.reason === 'parked_sales_present')
        setParked({ count: answer.parkedCount ?? null });
      else if (answer.reason === 'amount_out_of_range') rejectAmount(refusalEntry(answer.reason));
      else setError(refusalEntry(answer.reason));
    });
  };

  return (
    <ShiftCard heading={SHIFT_COPY.closeHeading} testId="shift-close-panel">
      <p className="v5-shift-hint">{SHIFT_COPY.blindHint}</p>
      <ShiftAmountField
        label={SHIFT_COPY.countLabel}
        value={count}
        onChange={setCount}
        error={error}
        inputRef={countRef}
      />
      {parked !== null && <ParkedSalesBlock count={parked.count} />}
      <div className="v5-shift-commit">
        <button
          ref={commitRef}
          type="button"
          className="v5-shift-btn v5-shift-btn--primary"
          disabled={busy || approving !== null}
          onClick={submit}
        >
          {SHIFT_COPY.closeCommit}
        </button>
      </div>
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
            setError(refusedCall(shiftRefusalMessage('approval_stale')));
          }}
        />
      )}
    </ShiftCard>
  );
}

/**
 * RT-658 (keyboard pass) — the commit is disabled while the approval dialog is
 * open, so a browser drops focus from it and the dialog has nothing to return
 * to. When the dialog goes away and the panel is still here (cancelled, or the
 * count went stale), focus goes back to the commit.
 */
function useFocusBackAfterApproval(
  approving: number | null,
  commitRef: RefObject<HTMLButtonElement | null>,
): void {
  const wasApproving = useRef(false);
  useEffect(() => {
    if (approving !== null) {
      wasApproving.current = true;
      return;
    }
    if (!wasApproving.current) return;
    wasApproving.current = false;
    commitRef.current?.focus();
  }, [approving, commitRef]);
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
      <Icon name="status.warning" />
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
