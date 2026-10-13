import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';

import { RecoveryScreen, windowRecoveryBridges, type RecoveryBridges } from './RecoveryScreen';

/** RT-441 — the route element: the screen over `window.api`, or back to the dashboard. */
export function RecoveryRoute(props: { bridges?: RecoveryBridges | null }): JSX.Element {
  const bridges = props.bridges === undefined ? windowRecoveryBridges() : props.bridges;
  if (bridges === null) return <Navigate to="/app/dashboard" replace />;
  return <RecoveryScreen bridges={bridges} />;
}
