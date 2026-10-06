import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { SHIFT_COPY } from '../../v5/shift/shift-copy';
import '../../v5/shift/shift.css';

const MANAGER_PATH = '/app/shift/manager';

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
  if (!enabled || (role !== 'manager' && role !== 'admin')) return null;
  return (
    <p className="v5-shift-notice" data-testid="dashboard-shift-link">
      <Link to={MANAGER_PATH}>{SHIFT_COPY.managerLink}</Link>
    </p>
  );
}
