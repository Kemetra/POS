import { useEffect, type JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { RecoveryListHeldResponse } from '../../../shared/operator/recovery';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { windowRecoveryBridges } from '../../v5/recovery/RecoveryScreen';
import { RECOVERY_COPY } from '../../v5/recovery/recovery-copy';

export const RECOVERY_PATH = '/app/manager/recovery';
const MANAGER_ROLES: ReadonlySet<string> = new Set(['manager', 'admin']);

function useIsManager(): boolean {
  return useOperatorSessionStore(
    (s) => s.state.kind === 'signedIn' && MANAGER_ROLES.has(s.state.session.role),
  );
}

const inRecoveryMode = (answer: RecoveryListHeldResponse): boolean =>
  answer.kind === 'held' && answer.recovery_mode;

/** A session main admitted in RECOVERY MODE goes straight to the recovery screen. */
function useRecoveryModeRedirect(enabled: boolean): void {
  const navigate = useNavigate();
  useEffect(() => {
    const bridges = enabled ? windowRecoveryBridges() : null;
    if (bridges === null) return;
    let live = true;
    bridges.recovery.listHeld().then(
      (answer) => {
        if (live && inRecoveryMode(answer)) void navigate(RECOVERY_PATH, { replace: true });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled, navigate]);
}

/**
 * RT-441 (RT-116 §5) — the manager dashboard's way into
 * `/app/manager/recovery`. A session main admitted in RECOVERY MODE is sent
 * there at once: it can do nothing else until the stuck payment is resolved.
 * Navigation only: nothing for a cashier; the route and main re-check.
 */
export function RecoveryLink(): JSX.Element | null {
  const isManager = useIsManager();
  useRecoveryModeRedirect(isManager);
  if (!isManager) return null;
  return (
    <p data-testid="dashboard-recovery-link">
      <Link to={RECOVERY_PATH}>{RECOVERY_COPY.link}</Link>
    </p>
  );
}
