import { useRef, type JSX, type ReactNode } from 'react';
import { ScreenTooSmall } from '../../ui/states/ScreenTooSmall';
import { useFocusOnReturn } from '../../viewport/useFocusOnReturn';
import { useViewportTier, viewportShortfall } from '../../viewport/useViewportTier';
import './route-states.css';

/**
 * RT-241 (VNext W1-A, VN-S2) — the supported-viewport guard for screens that
 * render outside the V5 frame (pairing, Ready, sign-in). Below the 1024px floor
 * only the Arabic ScreenTooSmall notice renders and the screen never mounts, so
 * none of its bridge calls run — the same rule the frame and AppShell apply.
 *
 * RT-313: the 600px height floor blocks the same way, with the height copy. On
 * return, a screen that focuses its own control keeps it; otherwise focus lands
 * on this guard's box. The box, not the screen's <main>: a screen that remounts
 * through a loading state (Ready) replaces its <main>, which would drop focus
 * back to <body>.
 */
export function SupportedViewport({ children }: { children: ReactNode }): JSX.Element {
  const shortfall = viewportShortfall(useViewportTier());
  const boxRef = useRef<HTMLDivElement>(null);
  useFocusOnReturn(shortfall !== null, () => boxRef.current);

  if (shortfall !== null) return <ScreenTooSmall shortfall={shortfall} />;
  return (
    <div ref={boxRef} className="v5-supported-viewport" tabIndex={-1}>
      {children}
    </div>
  );
}
