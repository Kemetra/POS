import type { JSX } from 'react';

import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { HOME_COPY } from '../../v5/manager/home/home-copy';
import { ManagerTile } from '../../v5/manager/home/ManagerTile';
import { SHIFT_COPY } from '../../v5/shift/shift-copy';

const MANAGER_PATH = '/app/shift/manager';
const MANAGER_ROLES: ReadonlySet<string> = new Set(['manager', 'admin']);

function isManagerRole(role: string | null): boolean {
  return role !== null && MANAGER_ROLES.has(role);
}

/**
 * RT-17 D3 (comments 10957 / 10958) — the legacy manager dashboard's way into
 * `/app/shift/manager`. Managers and admins land on the legacy shell, which has
 * no other link to the shift status. Navigation only: it renders nothing unless
 * the shift flag is on and a manager or admin is signed in; the route itself
 * re-checks both.
 */
export function ShiftManagerLink(): JSX.Element | null {
  const enabled = useFeatureFlagsStore((s) => s.shiftCashup);
  const role = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.role : null,
  );
  if (!enabled || !isManagerRole(role)) return null;
  return (
    <ManagerTile
      to={MANAGER_PATH}
      icon="manager-shift"
      title={SHIFT_COPY.managerLink}
      description={HOME_COPY.shift.description}
      testId="dashboard-shift-link"
    />
  );
}
