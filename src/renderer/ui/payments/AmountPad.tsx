import type { JSX } from 'react';

import { quickAmounts } from '../../../shared/payments/quick-amounts.js';
import { touchTarget } from '../tokens/touch.js';

/**
 * POS v3.5 Phase 3 — <AmountPad>.
 *
 * Controlled cash keypad: the caller owns `valueMinor` (integer minor units)
 * and receives edits via `onChange`. Digits fill from the right like a
 * register (1·0·0·0·0 ⇒ 100.00). Includes 0, 00, delete, and quick-amount
 * buttons sourced from the shared `quickAmounts` helper.
 *
 * It performs NO settlement math — no change-due, no totals. It only edits the
 * entered amount; change-due stays in money-math.ts. Money is shown `dir="ltr"`
 * mono even in the RTL shell (README brand rules). Recreated against POS-Pulse
 * tokens from the v3.5 design reference — prototype code not copied.
 */

const REGISTER_CEILING = 99_999_999; // 8-digit minor-unit ceiling (matches v3.5)
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function formatMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    return '0.00';
  }
  const whole = Math.floor(minor / 100);
  const frac = Math.abs(minor % 100)
    .toString()
    .padStart(2, '0');
  return `${whole.toString()}.${frac}`;
}

export interface AmountPadProps {
  /** Current entered amount in minor units; null/undefined is treated as 0. */
  valueMinor: number | null | undefined;
  onChange: (next: number) => void;
  /** Sale total in minor units — drives the quick-amount suggestions. */
  totalMinor: number;
}

export function AmountPad({ valueMinor, onChange, totalMinor }: AmountPadProps): JSX.Element {
  const current = valueMinor == null ? 0 : valueMinor;

  const pressDigit = (d: number): void => {
    onChange(Math.min(current * 10 + d, REGISTER_CEILING));
  };
  const pressDoubleZero = (): void => {
    onChange(Math.min(current * 100, REGISTER_CEILING));
  };
  const pressDelete = (): void => {
    onChange(Math.floor(current / 10));
  };

  const suggestions = quickAmounts(Number.isSafeInteger(totalMinor) ? totalMinor : 0);

  return (
    <div className="amount-pad" data-testid="amount-pad">
      <div className="amount-pad__display mono" dir="ltr" data-testid="amount-pad-display">
        {formatMinorUnits(current)}
      </div>

      <div className="amount-pad__quick" role="group" aria-label="مبالغ سريعة">
        {suggestions.map((amount) => (
          <button
            key={amount}
            type="button"
            className="amount-pad__quick-key mono"
            data-testid={`amount-pad-quick-${amount.toString()}`}
            style={{ minHeight: touchTarget.min }}
            onClick={() => {
              onChange(amount);
            }}
          >
            {formatMinorUnits(amount)}
          </button>
        ))}
      </div>

      <div className="amount-pad__grid">
        {DIGITS.map((k) => (
          <button
            key={k}
            type="button"
            className="amount-pad__key mono"
            data-testid={`amount-pad-key-${k.toString()}`}
            style={{ minHeight: touchTarget.min }}
            onClick={() => {
              pressDigit(k);
            }}
          >
            {k.toString()}
          </button>
        ))}
        <button
          type="button"
          className="amount-pad__key mono"
          data-testid="amount-pad-key-00"
          style={{ minHeight: touchTarget.min }}
          onClick={pressDoubleZero}
        >
          00
        </button>
        <button
          type="button"
          className="amount-pad__key mono"
          data-testid="amount-pad-key-0"
          style={{ minHeight: touchTarget.min }}
          onClick={() => {
            pressDigit(0);
          }}
        >
          0
        </button>
        <button
          type="button"
          className="amount-pad__key amount-pad__key--del"
          data-testid="amount-pad-delete"
          aria-label="حذف آخر رقم"
          style={{ minHeight: touchTarget.min }}
          onClick={pressDelete}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
