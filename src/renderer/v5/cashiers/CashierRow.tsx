import type { JSX } from 'react';

import type { CashierPinStatus } from '../../../shared/bridge-api.js';
import { CASHIERS_COPY, PIN_STATE_LABEL, lockedUntilText, nameInitial } from './cashiers-copy.js';

/**
 * RT-424 (D-M1, doc 19 §3) — one cashier row: initial, name, PIN badge and the
 * actions its state allows. An action that does not apply is not rendered at
 * all (UX-05: hidden, not disabled). The two action slots keep their width,
 * so the buttons line up row to row.
 *
 *   no_pin  → «تعيين أول رقم سري»
 *   ready   → «تغيير الرقم السري» (secondary, D1)
 *   locked  → «فك القفل» + «تغيير الرقم السري» (secondary)
 *
 * The badge pairs text with a glyph and a tone, never colour alone (UX-02).
 * The roster id never renders.
 */

export type RowAction = 'first' | 'change' | 'unlock';

export interface CashierRowProps {
  cashier: CashierPinStatus;
  disabled: boolean;
  onAction: (action: RowAction, cashier: CashierPinStatus) => void;
}

function StatusGlyph({ pin }: { pin: CashierPinStatus['pin'] }): JSX.Element {
  return (
    <svg className="v5-cashiers__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {pin === 'ready' && <path d="M5 12.5l4.5 4.5L19 7.5" />}
      {pin === 'no_pin' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M8.5 12h7" />
        </>
      )}
      {pin === 'locked' && <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />}
    </svg>
  );
}

export function PinStatusBadge({ cashier }: { cashier: CashierPinStatus }): JSX.Element {
  const until = cashier.pin === 'locked' ? cashier.locked_until : undefined;
  return (
    <span className="v5-cashiers__status" data-pin={cashier.pin} data-testid="pin-status">
      <StatusGlyph pin={cashier.pin} />
      {PIN_STATE_LABEL[cashier.pin]}
      {until !== undefined && (
        <>
          {' '}
          <time className="v5-ltr" dateTime={until}>
            {lockedUntilText(until)}
          </time>
        </>
      )}
    </span>
  );
}

function ActionButton({
  label,
  ghost,
  disabled,
  onClick,
}: {
  label: string;
  ghost: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={ghost ? 'v5-cashiers-btn v5-cashiers-btn--ghost' : 'v5-cashiers-btn'}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function CashierRow({ cashier, disabled, onAction }: CashierRowProps): JSX.Element {
  const primary: RowAction | null =
    cashier.pin === 'no_pin' ? 'first' : cashier.pin === 'locked' ? 'unlock' : null;
  const offersChange = cashier.pin !== 'no_pin';

  return (
    <li className="v5-cashiers__row" data-testid="cashier-row">
      <span className="v5-cashiers__initial" aria-hidden="true">
        {nameInitial(cashier.display_name)}
      </span>
      <span className="v5-cashiers__name">
        <bdi>{cashier.display_name}</bdi>
      </span>
      <PinStatusBadge cashier={cashier} />
      <div className="v5-cashiers__actions">
        <div className="v5-cashiers__act-primary">
          {primary !== null && (
            <ActionButton
              label={primary === 'first' ? CASHIERS_COPY.setFirstPin : CASHIERS_COPY.unlock}
              ghost={false}
              disabled={disabled}
              onClick={() => {
                onAction(primary, cashier);
              }}
            />
          )}
        </div>
        <div className="v5-cashiers__act-secondary">
          {offersChange && (
            <ActionButton
              label={CASHIERS_COPY.changePin}
              ghost
              disabled={disabled}
              onClick={() => {
                onAction('change', cashier);
              }}
            />
          )}
        </div>
      </div>
    </li>
  );
}
