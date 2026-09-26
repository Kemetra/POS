import type { JSX, ReactNode } from 'react';
import { CONNECTION_BANNER_MESSAGES, useConnectionState } from '../../connection/connection-state';
import { StatusBanner } from '../../ui/primitives/StatusBanner/StatusBanner';
import { ScreenTooSmall } from '../../ui/states/ScreenTooSmall';
import { useViewportTier } from '../../viewport/useViewportTier';
import { V5Navigation } from './V5Navigation';
import '../foundation/foundation.css';
import './frame.css';

interface V5FrameProps {
  /** Persistent operational notices (failure is loud, never a toast). */
  notices?: ReactNode;
  children: ReactNode;
}

/**
 * The single application frame for v5 screens: one <main>, one primary nav,
 * one brand. Screens render a labelled section inside <main> and never their
 * own landmark, header or branding.
 *
 * DOM order follows the RTL visual order: the working screen first (right),
 * navigation after it (left), as in the approved Sale reference. Keyboard
 * focus therefore reaches the screen before the navigation.
 *
 * AppShell parity (023 G0): below the 1024px floor only the too-small notice
 * renders, so the screen (and its bridge calls) never mounts; a non-online
 * connection state shows the same persistent banner as the legacy TopBar.
 */
export function V5Frame({ notices, children }: V5FrameProps): JSX.Element {
  const tier = useViewportTier();
  const { state: connectionState } = useConnectionState();

  if (tier === 'too-small') {
    return (
      <div className="v5-frame v5-frame--too-small" data-testid="v5-frame" dir="rtl" lang="ar">
        <ScreenTooSmall />
      </div>
    );
  }

  return (
    <div className="v5-frame" data-testid="v5-frame" dir="rtl" lang="ar">
      <div className="v5-frame__body">
        {connectionState !== 'online' && (
          <StatusBanner
            state={connectionState}
            message={CONNECTION_BANNER_MESSAGES[connectionState]}
          />
        )}
        {notices !== undefined && (
          <div className="v5-frame__notices" data-testid="v5-frame-notices">
            {notices}
          </div>
        )}
        <main className="v5-frame__main">{children}</main>
      </div>
      <V5Navigation />
    </div>
  );
}
