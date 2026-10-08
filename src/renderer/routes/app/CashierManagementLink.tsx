import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { useOperatorSessionStore } from '../../stores/operator-session-store';

const CASHIER_MANAGEMENT_PATH = '/app/manager/cashiers';
const MANAGER_ROLES: ReadonlySet<string> = new Set(['manager', 'admin']);

export const CASHIER_MANAGEMENT_LINK_LABEL = 'إدارة الكاشير';

function isManagerRole(role: string | null): boolean {
  return role !== null && MANAGER_ROLES.has(role);
}

/**
 * RT-235 — the legacy manager dashboard's way into `/app/manager/cashiers`
 * (Set first PIN / Reset PIN / Unlock). Nothing else links to that route, and
 * the packaged app has no address bar, so without this a manager could never
 * give a rostered cashier a first PIN. Navigation only: it renders nothing for
 * a cashier or a signed-out terminal; the route re-checks the role.
 */
export function CashierManagementLink(): JSX.Element | null {
  const role = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.role : null,
  );
  if (!isManagerRole(role)) return null;
  return (
    <p data-testid="dashboard-cashier-management-link">
      <Link to={CASHIER_MANAGEMENT_PATH}>{CASHIER_MANAGEMENT_LINK_LABEL}</Link>
    </p>
  );
}
