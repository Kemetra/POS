import type { JSX } from 'react';

import { Notice } from '../foundation/Notice';

/**
 * RT-656 — a recovery refusal: drawn as a V5 warning notice, announced as an
 * alert as before (a warning Notice alone is polite).
 */
export function RecoveryAlert({
  message,
}: Readonly<{ message: string | null }>): JSX.Element | null {
  if (message === null) return null;
  return (
    <div role="alert">
      <Notice tone="warning" announce={false}>
        {message}
      </Notice>
    </div>
  );
}
