import { useRef, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';

import type { Role } from '../../../shared/operator/role';
import { isShiftAmountWithinBound } from '../../../shared/shift-cashup/amount-bound';
import type {
  ShiftCashupBridgeAPI,
  ShiftCashupRefusal,
  ShiftOpenShiftView,
} from '../../../shared/shift-cashup/types';
import { CashMovementDialog, type MovementKind } from './CashMovementDialog';
import { CloseShiftPanel, type ShiftClosed } from './CloseShiftPanel';
import { callShift, useShiftStatus, useSingleFlight } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { parseShiftAmount } from './shift-format';
import {
  amountOutOfRange,
  invalidEntry,
  refusalEntry,
  ShiftAmountField,
  ShiftCard,
  ShiftMoney,
  ShiftTime,
  type FieldError,
} from './ShiftParts';
import { ShiftScreen } from './ShiftScreen';
import { Notice } from '../foundation/Notice';
import { Icon } from '../../icons/Icon';

interface Props {
  /** Tests inject a bridge (null = none); production reads `window.api`. */
  readonly bridge?: ShiftCashupBridgeAPI | null;
}

/** The device path records cashier facts only (`no_cashier_identity` otherwise). */
const CASHIER_ROLES: ReadonlyArray<Role> = ['cashier'];

/**
 * RT-17 slice 4 part 3 — `/app/shift`: the cashier's shift. With no open
 * shift, the opening float; with one, its summary (float and movement totals
 * only — never the expected cash), pay-in / pay-out and the blind-count close.
 * Every refusal shows its closed-set user message. Cashier only: the router
 * guards the route and this screen leaves for `/app` for any other role,
 * before any call.
 */
export function V5ShiftRoute({ bridge }: Props): JSX.Element | null {
  return (
    <ShiftScreen title={SHIFT_COPY.title} bridge={bridge} allow={CASHIER_ROLES}>
      {(api) => <CashierShift bridge={api} />}
    </ShiftScreen>
  );
}

type Outcome =
  | { kind: 'opened' }
  | { kind: 'recorded'; movement: MovementKind }
  | { kind: 'closed'; closed: ShiftClosed };

function CashierShift({ bridge }: Readonly<{ bridge: ShiftCashupBridgeAPI }>): JSX.Element {
  const { state, reload } = useShiftStatus(bridge);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const done = (next: Outcome): void => {
    setOutcome(next);
    reload();
  };

  if (state.kind === 'loading') {
    return (
      <output className="v5-shift-muted" aria-busy="true">
        {SHIFT_COPY.loading}
      </output>
    );
  }
  if (state.kind === 'refused') {
    return <StatusUnavailable outcome={outcome} reason={state.reason} onRetry={reload} />;
  }
  const open = state.status.openShift;
  const notice = outcome !== null && <ShiftOutcome outcome={outcome} />;
  if (open === null) {
    // G-2 Closed: the outcome and the opening form share one narrow column.
    return (
      <div className="v5-shift-state">
        {notice}
        <OpenShiftPanel
          bridge={bridge}
          onOpened={() => {
            done({ kind: 'opened' });
          }}
        />
      </div>
    );
  }
  return (
    <>
      {notice}
      <OpenShift
        bridge={bridge}
        open={open}
        onRecorded={(movement) => {
          done({ kind: 'recorded', movement });
        }}
        onClosed={(closed) => {
          done({ kind: 'closed', closed });
        }}
      />
    </>
  );
}

/**
 * The status read was refused or failed. A committed outcome stays on screen
 * (an approved close's variance is only in its answer); the failed refresh is
 * then a generic line beside it, never the refusal or any error text.
 */
function StatusUnavailable(
  props: Readonly<{
    outcome: Outcome | null;
    reason: ShiftCashupRefusal;
    onRetry: () => void;
  }>,
): JSX.Element {
  const { outcome } = props;
  const message = outcome === null ? shiftRefusalMessage(props.reason) : SHIFT_COPY.refreshFailed;
  return (
    <div className="v5-shift-state">
      {outcome !== null && <ShiftOutcome outcome={outcome} />}
      <Notice
        tone="warning"
        action={
          <button type="button" className="v5-shift-btn v5-btn" onClick={props.onRetry}>
            <Icon name="retry" />
            {SHIFT_COPY.retry}
          </button>
        }
      >
        {message}
      </Notice>
    </div>
  );
}

function ShiftOutcome({ outcome }: Readonly<{ outcome: Outcome }>): JSX.Element {
  if (outcome.kind === 'opened') {
    return (
      <Notice
        tone="success"
        action={
          <Link className="v5-shift-btn v5-btn" to="/app/cart">
            {SHIFT_COPY.goToSale}
          </Link>
        }
      >
        {SHIFT_COPY.opened}
      </Notice>
    );
  }
  if (outcome.kind === 'recorded') {
    const text = outcome.movement === 'payIn' ? SHIFT_COPY.recordedIn : SHIFT_COPY.recordedOut;
    return <Notice tone="success">{text}</Notice>;
  }
  const { varianceMinor, currencyCode } = outcome.closed;
  return (
    <Notice tone="success" testId="shift-closed-outcome">
      <p>{SHIFT_COPY.closed}</p>
      {varianceMinor !== undefined && (
        <p data-testid="shift-variance">
          {SHIFT_COPY.varianceLabel}:{' '}
          <ShiftMoney minor={varianceMinor} currencyCode={currencyCode} />
        </p>
      )}
    </Notice>
  );
}

function OpenShiftPanel(
  props: Readonly<{
    bridge: ShiftCashupBridgeAPI;
    onOpened: () => void;
  }>,
): JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<FieldError | null>(null);
  const { busy, run } = useSingleFlight();
  const fieldRef = useRef<HTMLInputElement>(null);

  /** The amount itself is wrong: say so under the field and give it focus back. */
  const rejectAmount = (next: FieldError): void => {
    setError(next);
    fieldRef.current?.focus();
  };

  const submit = (): void => {
    const openingFloatMinor = parseShiftAmount(value);
    if (openingFloatMinor === null) {
      setError(invalidEntry(SHIFT_COPY.invalidAmount));
      return;
    }
    // RT-278 S1: the flat cap main enforces. No shift is open, so no shift
    // currency is known yet; the product captures EGP only (as CashEntry).
    if (!isShiftAmountWithinBound('opening_float', openingFloatMinor, 'EGP')) {
      rejectAmount(amountOutOfRange());
      return;
    }
    setError(null);
    run(async () => {
      const answer = await callShift(() => props.bridge.open({ openingFloatMinor }));
      if (answer.kind === 'opened') props.onOpened();
      else if (answer.reason === 'amount_out_of_range') rejectAmount(refusalEntry(answer.reason));
      else setError(refusalEntry(answer.reason));
    });
  };

  return (
    <ShiftCard heading={SHIFT_COPY.openHeading}>
      <ShiftAmountField
        label={SHIFT_COPY.floatLabel}
        value={value}
        onChange={setValue}
        error={error}
        inputRef={fieldRef}
      />
      <div className="v5-shift-commit">
        <button
          type="button"
          className="v5-shift-btn v5-shift-btn--primary v5-btn v5-btn--primary"
          disabled={busy}
          onClick={submit}
        >
          {SHIFT_COPY.openCommit}
        </button>
      </div>
    </ShiftCard>
  );
}

function OpenShift(
  props: Readonly<{
    bridge: ShiftCashupBridgeAPI;
    open: ShiftOpenShiftView;
    onRecorded: (movement: MovementKind) => void;
    onClosed: (closed: ShiftClosed) => void;
  }>,
): JSX.Element {
  const { open } = props;
  const [movement, setMovement] = useState<MovementKind | null>(null);
  const money = (minor: number): JSX.Element => (
    <ShiftMoney minor={minor} currencyCode={open.currencyCode} />
  );

  return (
    <div className="v5-shift-grid">
      <ShiftCard
        testId="shift-summary"
        heading={
          <>
            {SHIFT_COPY.openSince} <ShiftTime iso={open.openedAt} />
          </>
        }
      >
        <dl className="v5-shift-ledger">
          <div>
            <dt>{SHIFT_COPY.floatRow}</dt>
            <dd>{money(open.openingFloatMinor)}</dd>
          </div>
          <div>
            <dt>{SHIFT_COPY.payInsRow}</dt>
            <dd>{money(open.payInTotalMinor)}</dd>
          </div>
          <div>
            <dt>{SHIFT_COPY.payOutsRow}</dt>
            <dd>{money(open.payOutTotalMinor)}</dd>
          </div>
        </dl>
        <div className="v5-shift-commit" data-testid="shift-actions">
          <button
            type="button"
            className="v5-shift-btn v5-btn"
            onClick={() => {
              setMovement('payIn');
            }}
          >
            {SHIFT_COPY.payIn}
          </button>
          <button
            type="button"
            className="v5-shift-btn v5-btn"
            onClick={() => {
              setMovement('payOut');
            }}
          >
            {SHIFT_COPY.payOut}
          </button>
        </div>
      </ShiftCard>
      <CloseShiftPanel
        bridge={props.bridge}
        currencyCode={open.currencyCode}
        onClosed={props.onClosed}
      />
      {movement !== null && (
        <CashMovementDialog
          bridge={props.bridge}
          kind={movement}
          currencyCode={open.currencyCode}
          onDismiss={() => {
            setMovement(null);
          }}
          onRecorded={() => {
            setMovement(null);
            props.onRecorded(movement);
          }}
        />
      )}
    </div>
  );
}
