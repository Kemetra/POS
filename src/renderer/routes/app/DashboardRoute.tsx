import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';

import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { ScreenSection } from '../../v5/foundation/ScreenSection';
import { CashierRefusal } from '../../v5/manager/home/CashierRefusal';
import { HOME_COPY } from '../../v5/manager/home/home-copy';
import '../../v5/manager/home/manager-home.css';
import { CashierManagementLink } from './CashierManagementLink';
import { RecoveryLink } from './RecoveryLink';
import { ShiftManagerLink } from './ShiftManagerLink';
import { StuckShiftsLink } from './StuckShiftsLink';

/**
 * RT-499 (VN-S10 S10-2, G-6) — the manager home, `/app/dashboard`: one card per
 * manager screen and no figure (there is no metrics contract). Each card keeps
 * the role gate it always had; `RecoveryLink` also keeps the recovery-mode
 * redirect, so a session in recovery mode still goes straight to
 * `/app/manager/recovery`. A cashier who opens the route directly gets an
 * Arabic refusal with a way back to the Sale.
 */
export function DashboardRoute(): JSX.Element {
  const state = useOperatorSessionStore((s) => s.state);

  if (state.kind !== 'signedIn') {
    return <Navigate to="/sign-in" replace />;
  }

  if (state.session.role === 'cashier') {
    return (
      <ScreenSection title={HOME_COPY.title}>
        <CashierRefusal />
      </ScreenSection>
    );
  }

  return (
    <ScreenSection title={HOME_COPY.title}>
      <ul className="v5-manager-home__tiles">
        <ShiftManagerLink />
        <CashierManagementLink />
        <RecoveryLink />
        <StuckShiftsLink />
      </ul>
    </ScreenSection>
  );
}
