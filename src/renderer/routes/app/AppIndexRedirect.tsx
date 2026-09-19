import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';

import { useOperatorSessionStore } from '../../stores/operator-session-store';

/**
 * 022 US1 / FR-44 — role-aware `/app` index landing.
 *
 * Replaces the static `<Navigate to="dashboard" replace />` that used to sit
 * on the `/app` index route.
 *
 * THE DEFECT IT FIXES: a signed-in cashier was redirected to `dashboard`,
 * where `DashboardRoute` rejects the cashier role with "Section unavailable" —
 * so the first screen of a cashier's shift was an error state.
 *
 * WHAT THIS CHANGES: where a signed-in operator is SENT from the bare `/app`
 * index. A cashier lands on the till (`/app/cart`); manager and admin continue
 * to `/app/dashboard` exactly as before.
 *
 * WHAT THIS DOES NOT CHANGE — the boundary is the whole point (FR-45/FR-47):
 *   - `DashboardRoute`'s role check is untouched. A cashier who navigates
 *     DIRECTLY to `/app/dashboard` is still refused.
 *   - No `OperatorRouteGuard`, no `allow` list, no feature flag, and no
 *     cashier access rule is altered.
 *   - No new capability is created; `/app/cart` was already reachable by a
 *     cashier through the nav.
 *
 * In short: this changes WHERE A CASHIER IS SENT, never WHAT A CASHIER MAY
 * REACH. Access control stays entirely with the guards that already own it.
 *
 * The signed-out case deliberately falls through to the dashboard path rather
 * than inventing a cashier landing: the operator guard wrapping `/app` owns
 * the redirect to sign-in, and this component must not assert a role it has no
 * session to support.
 */
export function AppIndexRedirect(): JSX.Element {
  const state = useOperatorSessionStore((s) => s.state);

  const target =
    state.kind === 'signedIn' && state.session.role === 'cashier' ? 'cart' : 'dashboard';

  return <Navigate to={target} replace />;
}
