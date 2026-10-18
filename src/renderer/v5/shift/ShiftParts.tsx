import { useId, type JSX, type ReactNode, type Ref } from 'react';

import type { ShiftCashupRefusal } from '../../../shared/shift-cashup/types';
import { Notice } from '../foundation/Notice';
import { shiftRefusalMessage } from './shift-copy';
import { formatShiftMoney, formatShiftTime } from './shift-format';

/**
 * RT-658 — the G-2 building blocks shared by the cashier and manager shift
 * screens (docs/design/vnext/visual-acceptance/G2-Shift/, g2.css): the G-6
 * card, a refusal notice in the region that caused it, an amount field, an
 * amount and the opening time. Presentation only; no call, no state.
 */

interface CardProps {
  readonly heading: ReactNode;
  /** Beside the heading, at the card's inline end (e.g. «تحديث»). */
  readonly action?: ReactNode;
  readonly testId?: string;
  readonly children: ReactNode;
}

/** A G-6 card: a region named by its own <h2>, a head and a body. */
export function ShiftCard({ heading, action, testId, children }: CardProps): JSX.Element {
  const headingId = useId();
  return (
    <section className="v5-shift-card" aria-labelledby={headingId} data-testid={testId}>
      <div className="v5-shift-card__head">
        <h2 id={headingId}>{heading}</h2>
        {action}
      </div>
      <div className="v5-shift-card__body">{children}</div>
    </section>
  );
}

/**
 * A refused (or rejected) call in the region that caused it: an interrupting
 * live region holding a warning notice, its id for the field it describes.
 */
export function ShiftRefusal({
  message,
  id,
}: Readonly<{ message: string | null; id?: string }>): JSX.Element | null {
  if (message === null) return null;
  return (
    <div role="alert" id={id}>
      <Notice tone="warning" announce={false}>
        {message}
      </Notice>
    </div>
  );
}

/** A message under a field: `invalid` when the entry itself is wrong, else a refusal. */
export interface FieldError {
  readonly message: string;
  readonly invalid: boolean;
}

/** The typed amount is not a valid amount. */
export const invalidEntry = (message: string): FieldError => ({ message, invalid: true });

/** Main refused the call; the entry itself was well formed. */
export const refusedCall = (message: string): FieldError => ({ message, invalid: false });

/** RT-278 S1: the amount is above its plausibility cap (scanner or typing digits). */
export function amountOutOfRange(): FieldError {
  return invalidEntry(shiftRefusalMessage('amount_out_of_range'));
}

/**
 * Main's refusal under the field: RT-278 S1's `amount_out_of_range` is about
 * the amount itself, so it marks the entry invalid like the pre-check does;
 * any other refusal is a refused call.
 */
export function refusalEntry(reason: ShiftCashupRefusal): FieldError {
  return reason === 'amount_out_of_range'
    ? amountOutOfRange()
    : refusedCall(shiftRefusalMessage(reason));
}

interface AmountFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The message shown under the field and announced; null when none. */
  readonly error?: FieldError | null;
  readonly inputRef?: Ref<HTMLInputElement>;
}

/** A labelled amount entry: LTR and tabular, described by its message, marked only when invalid. */
export function ShiftAmountField(props: AmountFieldProps): JSX.Element {
  const inputId = useId();
  const errorId = useId();
  const error = props.error ?? null;
  return (
    <>
      <div className="v5-shift-field">
        <label htmlFor={inputId}>{props.label}</label>
        <input
          id={inputId}
          ref={props.inputRef}
          className="v5-shift-amount"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          value={props.value}
          aria-invalid={error?.invalid === true ? true : undefined}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      </div>
      <ShiftRefusal message={error?.message ?? null} id={errorId} />
    </>
  );
}

/** An amount main sent: an LTR, tabular, mono run. */
export function ShiftMoney({
  minor,
  currencyCode,
}: Readonly<{ minor: number; currencyCode: string }>): JSX.Element {
  return <span className="v5-ltr v5-shift-money">{formatShiftMoney(minor, currencyCode)}</span>;
}

/** The opening time: Arabic text in the body face, never the LTR mono run. */
export function ShiftTime({ iso }: Readonly<{ iso: string }>): JSX.Element {
  return <time dateTime={iso}>{formatShiftTime(iso)}</time>;
}
