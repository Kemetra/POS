import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { CONNECTION_BANNER_MESSAGES, useConnectionState } from '../../connection/connection-state';
import { StatusBanner } from '../../ui/primitives/StatusBanner/StatusBanner';
import type { ConnectionState } from '../../ui/tokens/connection-state';
import { ScreenTooSmall } from '../../ui/states/ScreenTooSmall';
import { useFocusOnReturn } from '../../viewport/useFocusOnReturn';
import { useViewportTier, viewportShortfall } from '../../viewport/useViewportTier';
import { DialogHost } from '../foundation/Dialog';
import { V5Navigation } from './V5Navigation';
import { isActiveSaleRoute } from './nav-model';
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
 * RT-241: one DialogHost inside the frame is the portal node for every v5
 * dialog, so a dialog keeps the frame's RTL scope and tokens and sits inside
 * the lock's inert, concealed subtree.
 *
 * AppShell parity (023 G0): below the 1024px floor only the too-small notice
 * renders, so the screen (and its bridge calls) never mounts; a non-online
 * connection state shows the same persistent banner as the legacy TopBar.
 *
 * RT-313 (RT-312 D1/D2/D6): the same applies below the 600px height floor,
 * with the notice's height copy. The screen unmounts and remounts as before.
 * On return, a screen that focuses its own control keeps it; otherwise focus
 * lands on <main>, never on <body>.
 *
 * RT-242 (VN-S12): on an active-sale route the nav is the slim rail
 * (`data-nav="slim"`), elsewhere the labelled panel — decided by the route
 * alone, never by cart state.
 *
 * RT-498 (VN-S10 S10-1, D-10-7): the `?conn=` dev toggle the legacy AppShell
 * carried lives here now, so the connection banner stays exercisable until a
 * real signal exists (VN-S6). Dev builds only; the module is imported lazily
 * so a production build never ships it.
 */
function useDevConnectionToggle(setConnectionState: (state: ConnectionState) => void): void {
  useEffect(() => {
    const metaEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (!metaEnv?.DEV) return;
    void import('../../connection/dev-toggles').then(({ getDevToggles }) => {
      setConnectionState(getDevToggles().conn);
    });
    // Once on mount: URL search params are static per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function V5Frame({ notices, children }: V5FrameProps): JSX.Element {
  const shortfall = viewportShortfall(useViewportTier());
  const { state: connectionState, setState: setConnectionState } = useConnectionState();
  useDevConnectionToggle(setConnectionState);
  const { pathname } = useLocation();
  const nav = isActiveSaleRoute(pathname) ? 'slim' : 'panel';
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnReturn(shortfall !== null, () => mainRef.current);

  if (shortfall !== null) {
    return (
      <div className="v5-frame v5-frame--too-small" data-testid="v5-frame" dir="rtl" lang="ar">
        <ScreenTooSmall shortfall={shortfall} />
      </div>
    );
  }

  return (
    <div className="v5-frame" data-testid="v5-frame" data-nav={nav} dir="rtl" lang="ar">
      <DialogHost>
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
          <main ref={mainRef} className="v5-frame__main" tabIndex={-1}>
            {children}
          </main>
        </div>
        <V5Navigation />
      </DialogHost>
    </div>
  );
}
