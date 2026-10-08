import { useId, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';

import type { Role } from '../../../shared/operator/role';
import type {
  ShiftCashupBridgeAPI,
  ShiftCashupRefusal,
  ShiftOpenShiftView,
} from '../../../shared/shift-cashup/types';
import { CashMovementDialog, type MovementKind } from './CashMovementDialog';
import { CloseShiftPanel, type ShiftClosed } from './CloseShiftPanel';
import { callShift, useShiftStatus, useSingleFlight } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { formatShiftMoney, formatShiftTime, parseShiftAmount } from './shift-format';
import { ShiftAlert, ShiftScreen } from './ShiftScreen';

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
    <ShiftScreen
      title={SHIFT_COPY.title}
      titleId="v5-shift-title"
      bridge={bridge}
      allow={CASHIER_ROLES}
    >
      {(api) => <CashierShift bridge={api} />}
    </ShiftScreen>
  );
}

type Outcome =
  | { kind: 'opened' }
  | { kind: 'recorded'; movement: MovementKind }
  | { kind: 'closed'; closed: ShiftClosed };

function CashierShift({ bridge }: { bridge: ShiftCashupBridgeAPI }): JSX.Element {
  const { state, reload } = useShiftStatus(bridge);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const done = (next: Outcome): void => {
    setOutcome(next);
    reload();
  };

  if (state.kind === 'loading') {
    return <p className="v5-shift-message">{SHIFT_COPY.loading}</p>;
  }
  if (state.kind === 'refused') {
    return <StatusUnavailable outcome={outcome} reason={state.reason} onRetry={reload} />;
  }
  const open = state.status.openShift;
  return (
    <>
      {outcome !== null && <ShiftOutcome outcome={outcome} />}
      {open === null ? (
        <OpenShiftPanel
          bridge={bridge}
          onOpened={() => {
            done({ kind: 'opened' });
          }}
        />
      ) : (
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
      )}
    </>
  );
}

/**
 * The status read was refused or failed. A committed outcome stays on screen
 * (an approved close's variance is only in its answer); the failed refresh is
 * then a generic line beside it, never the refusal or any error text.
 */
function StatusUnavailable(props: {
  outcome: Outcome | null;
  reason: ShiftCashupRefusal;
  onRetry: () => void;
}): JSX.Element {
  const { outcome } = props;
  const message = outcome === null ? shiftRefusalMessage(props.reason) : SHIFT_COPY.refreshFailed;
  return (
    <>
      {outcome !== null && <ShiftOutcome outcome={outcome} />}
      <div className="v5-shift-panel">
        <p className="v5-shift-message">{message}</p>
        <button type="button" className="v5-shift-btn" onClick={props.onRetry}>
          {SHIFT_COPY.retry}
        </button>
      </div>
    </>
  );
}

function ShiftOutcome({ outcome }: { outcome: Outcome }): JSX.Element {
  if (outcome.kind === 'opened') {
    return (
      <div className="v5-shift-outcome" role="status">
        <p>{SHIFT_COPY.opened}</p>
        <Link to="/app/cart">{SHIFT_COPY.goToSale}</Link>
      </div>
    );
  }
  if (outcome.kind === 'recorded') {
    const text = outcome.movement === 'payIn' ? SHIFT_COPY.recordedIn : SHIFT_COPY.recordedOut;
    return (
      <p className="v5-shift-outcome" role="status">
        {text}
      </p>
    );
  }
  const { varianceMinor, currencyCode } = outcome.closed;
  return (
    <div className="v5-shift-outcome" role="status" data-testid="shift-closed-outcome">
      <p>{SHIFT_COPY.closed}</p>
      {varianceMinor !== undefined && (
        <p data-testid="shift-variance">
          {SHIFT_COPY.varianceLabel}:{' '}
          <span className="v5-ltr v5-shift-money">
            {formatShiftMoney(varianceMinor, currencyCode)}
          </span>
        </p>
      )}
    </div>
  );
}

function OpenShiftPanel(props: {
  bridge: ShiftCashupBridgeAPI;
  onOpened: () => void;
}): JSX.Element {
  const inputId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useSingleFlight();

  const submit = (): void => {
    const openingFloatMinor = parseShiftAmount(value);
    if (openingFloatMinor === null) {
      setError(SHIFT_COPY.invalidAmount);
      return;
    }
    setError(null);
    run(async () => {
      const answer = await callShift(() => props.bridge.open({ openingFloatMinor }));
      if (answer.kind === 'opened') props.onOpened();
      else setError(shiftRefusalMessage(answer.reason));
    });
  };

  return (
    <div className="v5-shift-panel">
      <h2>{SHIFT_COPY.openHeading}</h2>
      <label htmlFor={inputId}>{SHIFT_COPY.floatLabel}</label>
      <input
        id={inputId}
        className="v5-shift-input v5-ltr"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <ShiftAlert message={error} />
      <button
        type="button"
        className="v5-shift-btn v5-shift-btn--primary"
        disabled={busy}
        onClick={submit}
      >
        {SHIFT_COPY.openCommit}
      </button>
    </div>
  );
}

function OpenShift(props: {
  bridge: ShiftCashupBridgeAPI;
  open: ShiftOpenShiftView;
  onRecorded: (movement: MovementKind) => void;
  onClosed: (closed: ShiftClosed) => void;
}): JSX.Element {
  const { open } = props;
  const [movement, setMovement] = useState<MovementKind | null>(null);
  const money = (minor: number): JSX.Element => (
    <span className="v5-ltr v5-shift-money">{formatShiftMoney(minor, open.currencyCode)}</span>
  );

  return (
    <div className="v5-shift-columns">
      <div className="v5-shift-panel" data-testid="shift-summary">
        <h2>
          {SHIFT_COPY.openSince} <span className="v5-ltr">{formatShiftTime(open.openedAt)}</span>
        </h2>
        <dl className="v5-shift-facts">
          <dt>{SHIFT_COPY.floatRow}</dt>
          <dd>{money(open.openingFloatMinor)}</dd>
          <dt>{SHIFT_COPY.payInsRow}</dt>
          <dd>{money(open.payInTotalMinor)}</dd>
          <dt>{SHIFT_COPY.payOutsRow}</dt>
          <dd>{money(open.payOutTotalMinor)}</dd>
        </dl>
        <div className="v5-shift-actions" data-testid="shift-actions">
          <button
            type="button"
            className="v5-shift-btn"
            onClick={() => {
              setMovement('payIn');
            }}
          >
            {SHIFT_COPY.payIn}
          </button>
          <button
            type="button"
            className="v5-shift-btn"
            onClick={() => {
              setMovement('payOut');
            }}
          >
            {SHIFT_COPY.payOut}
          </button>
        </div>
      </div>
      <CloseShiftPanel
        bridge={props.bridge}
        currencyCode={open.currencyCode}
        onClosed={props.onClosed}
      />
      {movement !== null && (
        <CashMovementDialog
          bridge={props.bridge}
          kind={movement}
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
