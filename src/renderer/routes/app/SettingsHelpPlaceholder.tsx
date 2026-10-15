/**
 * RT-503 (VN-S10 S10-6) — Settings: an honest Arabic notice that nothing can be
 * changed on this terminal (G-6 state 13). No theme toggle (owner decision
 * D-10-3: dark is maintained, not offered; the theme store stays), no
 * «coming soon» rows, no fake connection row, no dev `?state=` gallery.
 *
 * Navigation-only: no fetch, no IPC, no persistence.
 */
import type { JSX } from 'react';

import { ScreenSection } from '../../v5/foundation/ScreenSection';
import { HonestNotice } from '../../v5/manager/honest/HonestNotice';
import { HONEST_COPY } from '../../v5/manager/honest/honest-copy';

export function SettingsHelpPlaceholder(): JSX.Element {
  return (
    <ScreenSection title={HONEST_COPY.settings.title}>
      <div className="v5-honest-state">
        <HonestNotice notice={HONEST_COPY.settings.notice} />
      </div>
    </ScreenSection>
  );
}
