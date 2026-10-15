import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';

import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { windowVoidBridges, type VoidBridges } from './void-bridges';
import { VoidScreen } from './VoidScreen';

/**
 * RT-530 — the `/app/void` route element: the screen over `window.api`.
 *
 * Fail-closed in the renderer too: with the flag off (or not yet hydrated) or
 * no void bridge it leaves for /app and makes no call; main refuses every call
 * on its own read of the flag and the session. The screen is keyed by the
 * operator session, so a different operator never inherits the previous one
 * lookup or outcome.
 */
export interface VoidRouteProps {
  /** Tests inject bridges (null = none); production reads `window.api`. */
  readonly bridges?: VoidBridges | null;
  readonly refreshMs?: number;
}

export function VoidRoute({ bridges, refreshMs }: VoidRouteProps): JSX.Element | null {
  const enabled = useFeatureFlagsStore((s) => s.saleVoid);
  const sessionId = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.id : null,
  );
  const api = bridges === undefined ? windowVoidBridges() : bridges;
  if (sessionId === null) return null;
  if (!enabled || api === null) return <Navigate to="/app" replace />;
  return (
    <VoidScreen key={sessionId} bridges={api} {...(refreshMs === undefined ? {} : { refreshMs })} />
  );
}
