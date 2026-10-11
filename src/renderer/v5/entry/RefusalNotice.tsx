import type { JSX, ReactNode } from 'react';

import { ToneIcon } from '../foundation/ToneIcon';
import '../foundation/messages.css';

/**
 * RT-244 — a sign-in refusal inside the reserved feedback slot: the v5 danger
 * notice anatomy (tone glyph + one sentence), as an alert inside the slot's
 * polite live region, so the existing one-message-at-a-time rule holds
 * (Note 1: alert XOR spinner).
 */
export function RefusalNotice({
  children,
  testId,
  category,
  id,
}: {
  children: ReactNode;
  testId: string;
  category?: string;
  id?: string;
}): JSX.Element {
  return (
    <span
      role="alert"
      id={id}
      className="v5-notice"
      data-tone="danger"
      data-testid={testId}
      data-category={category}
    >
      <ToneIcon tone="danger" />
      <span className="v5-notice__text">{children}</span>
    </span>
  );
}
