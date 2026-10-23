import type { JSX } from 'react';

import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { Notice } from '../foundation/Notice';

/**
 * RT-654 — small pieces shared by the void screen and its dialog.
 *
 * - The sale number is an LTR monospace ID run and amounts are LTR runs in the
 *   money family (RT-833); each is its own <bdi dir="ltr">. Arabic text never
 *   takes the mono face (DESIGN.md numerals).
 * - A refusal is a V5 warning notice. It keeps the `alert` role the screen
 *   announced it with before (ShiftAlert), so the outer box announces and the
 *   notice itself stays quiet: one announcement per message.
 */
export function VoidCode({
  value,
  className,
}: Readonly<{ value: string; className?: string }>): JSX.Element {
  return (
    <bdi dir="ltr" className={className === undefined ? 'v5-void-id' : `v5-void-id ${className}`}>
      {value}
    </bdi>
  );
}

export function VoidMoney({
  minor,
  className,
}: Readonly<{ minor: number; className?: string }>): JSX.Element {
  return (
    <bdi
      dir="ltr"
      className={className === undefined ? 'v5-void-money' : `v5-void-money ${className}`}
    >
      {formatCheckoutMoney(minor)}
    </bdi>
  );
}

export function VoidAlert({ message }: Readonly<{ message: string }>): JSX.Element {
  return (
    <div role="alert" className="v5-void-alert">
      <Notice tone="warning" announce={false}>
        {message}
      </Notice>
    </div>
  );
}
