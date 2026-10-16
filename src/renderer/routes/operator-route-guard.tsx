import type { ReactNode, JSX } from 'react';
import { Navigate } from 'react-router-dom';

import { useOperatorSessionStore } from '../stores/operator-session-store.js';
import type { Role } from '../../shared/operator/role.js';

/**
 * 004-operator-session T017 — operator route guard (AD-1 secondary).
 *
 * The PRIMARY trust boundary is `requireRole` in main-process bridge
 * handlers — the route guard is a SECONDARY UX defence to keep the
 * renderer from rendering a surface the operator's role disallows.
 * Its only job is to redirect:
 *
 *   - `signedOut` (or any non-`signedIn` state) → /sign-in
 *   - `signedIn` with role outside `allow` → /sign-in (generic; AD-1)
 *
 * The compiled-in role check mirrors the role-visibility-matrix in
 * `specs/004-operator-session/contracts/role-visibility-matrix.md`. S1
 * exposes the gate but does not yet wire any /app/* sub-route through
 * a role-restricted variant (those land with the manager-only stuck-
 * shifts and cashier-management surfaces in S4 / S5).
 */

export interface OperatorRouteGuardProps {
  /** Closed list of roles that may render `children`. */
  allow?: ReadonlyArray<Role>;
  /** Where to redirect on a guard miss. Defaults to /sign-in. */
  redirectTo?: string;
  children: ReactNode;
}

export function OperatorRouteGuard(props: Readonly<OperatorRouteGuardProps>): JSX.Element {
  const state = useOperatorSessionStore((s) => s.state);
  const redirectTo = props.redirectTo ?? '/sign-in';

  if (state.kind !== 'signedIn') {
    return <Navigate to={redirectTo} replace />;
  }

  const allow = props.allow;
  if (allow !== undefined && !allow.includes(state.session.role)) {
    return <Navigate to={redirectTo} replace />;
  }

  return <>{props.children}</>;
}
