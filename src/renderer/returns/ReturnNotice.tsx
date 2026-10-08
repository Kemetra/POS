import type { JSX } from 'react';

import { OUTCOME_COPY, refusalMessage } from './returns-messages.js';
import type { FlowNotice } from './return-flow-state.js';

/** RT-15 S3 — one notice line: the refusal's own message, or the failure copy (O2, O6). */
export function noticeMessage(notice: FlowNotice): string {
  if (notice.kind === 'refused') return refusalMessage(notice.reason);
  return notice.kind === 'empty' ? 'أدخل رقم البيع.' : OUTCOME_COPY.callFailed;
}

/** Announced at once (role=alert): it stops the operator's next step. */
export function ReturnNotice({
  notice,
}: {
  readonly notice: FlowNotice | null;
}): JSX.Element | null {
  if (notice === null) return null;
  return (
    <p className="rt-returns__notice" role="alert">
      {noticeMessage(notice)}
    </p>
  );
}
