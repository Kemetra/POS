import type { JSX, ReactNode } from 'react';
import { ScreenTooSmall } from '../../ui/states/ScreenTooSmall';
import { useViewportTier } from '../../viewport/useViewportTier';

/**
 * RT-241 (VNext W1-A, VN-S2) — the supported-viewport guard for screens that
 * render outside the V5 frame (pairing, Ready, sign-in). Below the 1024px floor
 * only the Arabic ScreenTooSmall notice renders and the screen never mounts, so
 * none of its bridge calls run — the same rule the frame and AppShell apply.
 */
export function SupportedViewport({ children }: { children: ReactNode }): JSX.Element {
  const tier = useViewportTier();
  return tier === 'too-small' ? <ScreenTooSmall /> : <>{children}</>;
}
