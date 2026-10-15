/**
 * POS v3.5 Slice 1 — AuditPlaceholder (thin "coming soon" pane).
 *
 * The Audit surface is a later display slice (a chronological, append-only
 * audit log of every accountable action — see prototype README §8). Until that
 * slice lands, the nav entry routes here to a thin placeholder so the 7-entry
 * rail is fully reachable without implying functionality.
 *
 * Navigation-only: no fetch, no IPC, no persistence, no audit-log read.
 */
import type { JSX } from 'react';
import { ScreenSection } from '../../v5/foundation/ScreenSection';

export function AuditPlaceholder(): JSX.Element {
  return (
    <ScreenSection title="Audit">
      <section className="placeholder-pane">
        <p>The audit log view is not yet available at this terminal. Coming soon.</p>
      </section>
    </ScreenSection>
  );
}
