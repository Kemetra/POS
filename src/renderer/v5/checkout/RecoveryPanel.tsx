import type { JSX } from 'react';

import { Notice } from '../foundation/Notice';

/**
 * RT-243 W1-C (freeze 15 §4 `RecoveryPanel`; 06 RecoveryPanel; §5 M-P17–M-P20)
 * — the payment recovery lines, kept with the commit in the pinned action bar.
 *
 * It presents what Checkout already knows; it decides nothing. Each line is the
 * catalogue copy for one recovery state:
 *
 *   - a reversal still being processed: an info Notice (recorded, not proven);
 *   - a cancel whose outcome main could not confirm (M-P18): a danger Notice.
 *     Money may or may not have moved, so it is the one recovery line that must
 *     not read as routine (freeze 15 §5: "danger styling is W1-C scope");
 *   - every other payment refusal (M-P17, M-P19, M-P20, a start or settle that
 *     failed): a plain status line, neutral as the catalogue asks.
 *
 * No line offers a re-charge. A retry, where one can succeed, is the existing
 * Cancel or commit, named in the copy itself (UX-07).
 *
 * Presentational: copy in, no store, no bridge. Test hooks the caller owns
 * arrive through `testIds`, so the V5 tree stays free of legacy names.
 */

export interface RecoveryPanelTestIds {
  readonly refusal?: string;
  readonly reversalPending?: string;
}

export interface RecoveryPanelProps {
  /** The current payment refusal line, or null for none. */
  readonly refusal: string | null;
  /** True when this refusal is the cancel-outcome-unknown line (M-P18). */
  readonly refusalIsUnknownOutcome: boolean;
  /** A reversal main has accepted but not finished. */
  readonly reversalPending: boolean;
  readonly testIds?: RecoveryPanelTestIds;
}

/** `Notice` takes `testId` only when there is one (exactOptionalPropertyTypes). */
function optionalTestId(testId: string | undefined): { testId?: string } {
  return testId === undefined ? {} : { testId };
}

const REVERSAL_PENDING_COPY = 'هناك عمليات عكس قيد المعالجة وستتم قريباً.';

export function RecoveryPanel({
  refusal,
  refusalIsUnknownOutcome,
  reversalPending,
  testIds = {},
}: RecoveryPanelProps): JSX.Element | null {
  if (refusal === null && !reversalPending) return null;
  return (
    <div className="v5-recovery" data-testid="recovery-panel">
      {reversalPending && (
        <Notice tone="info" {...optionalTestId(testIds.reversalPending)}>
          {REVERSAL_PENDING_COPY}
        </Notice>
      )}
      {refusal !== null &&
        (refusalIsUnknownOutcome ? (
          <Notice tone="danger" {...optionalTestId(testIds.refusal)}>
            {refusal}
          </Notice>
        ) : (
          <p
            className="v5-recovery__line"
            data-testid={testIds.refusal}
            role="status"
            aria-live="polite"
          >
            {refusal}
          </p>
        ))}
    </div>
  );
}
