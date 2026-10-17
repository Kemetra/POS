import { useRef, type JSX, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
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
 * renders, so the screen (and its bridge calls) never mounts.
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
 * RT-595 (RT-505 F1): the notices strip is a labelled complementary landmark
 * (`<aside>`): it mixes status banners with the shift / void links, so it is
 * not a navigation region, and it keeps axe's `region` rule clean.
 *
 * RT-605 (VN-S6 S6-4): the connection banner lives in the notices stack
 * (M-O1, from the real terminal signal). RT-606 (S6-5) retired the 007
 * StatusBanner, the renderer connection store and the `?conn=` dev toggle.
 */
export function V5Frame({ notices, children }: Readonly<V5FrameProps>): JSX.Element {
  const shortfall = viewportShortfall(useViewportTier());
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
          {notices !== undefined && (
            <aside
              className="v5-frame__notices"
              data-testid="v5-frame-notices"
              aria-label="إشعارات التشغيل"
            >
              {notices}
            </aside>
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
