import type { JSX } from 'react';

import { formatCheckoutMoney } from '../../ui/payments/format-checkout-money';
import { Notice } from '../foundation/Notice';

/**
 * RT-654 — small pieces shared by the void screen and its dialog.
 *
 * - The sale number and amounts are the only LTR tabular (monospace) runs;
 *   Arabic text never takes that face (DESIGN.md numerals).
 * - A refusal is a V5 warning notice. It keeps the `alert` role the screen
 *   announced it with before (ShiftAlert), so the outer box announces and the
 *   notice itself stays quiet: one announcement per message.
 */
export function VoidCode({
  value,
  className,
}: Readonly<{ value: string; className?: string }>): JSX.Element {
  return (
    <bdi dir="ltr" className={className === undefined ? 'v5-void-num' : `v5-void-num ${className}`}>
      {value}
    </bdi>
  );
}

export function VoidMoney({
  minor,
  className,
}: Readonly<{ minor: number; className?: string }>): JSX.Element {
  return <VoidCode value={formatCheckoutMoney(minor)} {...(className ? { className } : {})} />;
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
