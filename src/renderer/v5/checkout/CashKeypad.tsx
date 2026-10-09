import type { JSX } from 'react';

/**
 * RT-243 W1-C (freeze 15 §6 Checkout / cash; VN-B2) — the cash keypad. It
 * replaces the legacy `AmountPad`.
 *
 * LTR in the RTL shell: 1 2 3 on the top row from the left, 00 0 ⌫ at the
 * foot, as on a calculator, a card terminal and the reference. It is an input
 * device, not text, so the grid is `dir="ltr"` rather than mirrored.
 *
 * Register fill: digits enter from the right (1·0·0·0·0 → 100.00), `00` adds
 * two zeros and ⌫ drops the last digit. It edits the amount only; there is no
 * display of its own (the amount field above shows the one value) and no money
 * math beyond shifting digits in integer minor units.
 */

const REGISTER_CEILING = 99_999_999; // eight minor-unit digits
const ROWS: readonly (readonly number[])[] = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
];

export interface CashKeypadProps {
  /** The amount in the field, integer minor units; null is treated as 0. */
  readonly valueMinor: number | null;
  readonly onChange: (next: number) => void;
}

export function CashKeypad({ valueMinor, onChange }: CashKeypadProps): JSX.Element {
  const current = valueMinor !== null && Number.isSafeInteger(valueMinor) ? valueMinor : 0;
  const shift = (factor: number, digit: number): void => {
    onChange(Math.min(current * factor + digit, REGISTER_CEILING));
  };

  return (
    <div className="v5-cash-keypad" dir="ltr" data-testid="cash-keypad">
      {ROWS.flat().map((d) => (
        <button
          key={d}
          type="button"
          className="v5-cash-keypad__key"
          data-testid={`cash-keypad-key-${String(d)}`}
          onClick={() => {
            shift(10, d);
          }}
        >
          {d}
        </button>
      ))}
      <button
        type="button"
        className="v5-cash-keypad__key"
        data-testid="cash-keypad-key-00"
        onClick={() => {
          shift(100, 0);
        }}
      >
        00
      </button>
      <button
        type="button"
        className="v5-cash-keypad__key"
        data-testid="cash-keypad-key-0"
        onClick={() => {
          shift(10, 0);
        }}
      >
        0
      </button>
      <button
        type="button"
        className="v5-cash-keypad__key v5-cash-keypad__key--delete"
        data-testid="cash-keypad-delete"
        aria-label="حذف آخر رقم"
        onClick={() => {
          onChange(Math.floor(current / 10));
        }}
      >
        <span aria-hidden="true">⌫</span>
      </button>
    </div>
  );
}
