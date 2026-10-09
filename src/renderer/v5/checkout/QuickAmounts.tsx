import type { JSX } from 'react';

import { quickAmounts } from '../../../shared/payments/quick-amounts';
import { formatHumanMoney } from '../../ui/format/human-format';

/**
 * RT-243 W1-C (freeze 15 §6 Checkout / cash; 06 `QuickAmounts`) — the cash
 * quick amounts, one group under the amount field.
 *
 * Each chip SETS the amount received; it never adds to it (VN-B2). «بالضبط» is
 * the amount still due; the others are the first three banknote roll-ups above
 * it (`quickAmounts`). Nothing here subtracts or settles: the change is main's, or
 * the ledger's preview through `computeChangeDueMinor`.
 *
 * The chip that matches the amount in the field is pressed (`aria-pressed`), so
 * the state is announced and survives forced colours, never colour alone. The
 * group carries no name of its own: borrowing the field's label would give two
 * controls the same accessible name, and a new name is catalogue copy (§5).
 */

/** «بالضبط» plus three roll-ups: one row at 1024 and 1280 (VN-B2). */
const MAX_ROUND_UPS = 3;

export interface QuickAmountsProps {
  /** What is still owed, integer minor units. */
  readonly dueMinor: number;
  /** The amount in the field, or null when it is empty or unparseable. */
  readonly valueMinor: number | null;
  /** Sets the amount received to the chip's value. */
  readonly onSet: (minor: number) => void;
}

export function QuickAmounts({
  dueMinor,
  valueMinor,
  onSet,
}: QuickAmountsProps): JSX.Element | null {
  if (!Number.isSafeInteger(dueMinor) || dueMinor <= 0) return null;
  const roundUps = quickAmounts(dueMinor)
    .filter((v) => v > dueMinor)
    .slice(0, MAX_ROUND_UPS);
  return (
    <div className="v5-quick-amounts" role="group" data-testid="quick-amounts">
      <button
        type="button"
        className="v5-quick-amount v5-quick-amount--exact"
        data-testid="quick-amount-exact"
        aria-pressed={valueMinor === dueMinor}
        onClick={() => {
          onSet(dueMinor);
        }}
      >
        بالضبط
      </button>
      {roundUps.map((v) => (
        <button
          key={v}
          type="button"
          className="v5-quick-amount"
          data-testid="quick-amount"
          aria-pressed={valueMinor === v}
          onClick={() => {
            onSet(v);
          }}
        >
          <bdi dir="ltr">{formatHumanMoney(v)}</bdi>
        </button>
      ))}
    </div>
  );
}
