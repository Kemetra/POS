/**
 * RT-503 (VN-S10 S10-6) — the Audit screen says, honestly and in Arabic, that
 * the audit log is not shown on this terminal (G-6 state 10). It implies no log
 * exists.
 *
 * Navigation-only: no fetch, no IPC, no persistence, no audit-log read.
 */
import type { JSX } from 'react';
import { ScreenSection } from '../../v5/foundation/ScreenSection';
import { HonestNotice } from '../../v5/manager/honest/HonestNotice';
import { HONEST_COPY } from '../../v5/manager/honest/honest-copy';

export function AuditPlaceholder(): JSX.Element {
  return (
    <ScreenSection title={HONEST_COPY.audit.title}>
      <div className="v5-honest-state">
        <HonestNotice notice={HONEST_COPY.audit.notice} />
      </div>
    </ScreenSection>
  );
}
