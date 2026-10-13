import { useEffect, type JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { windowRecoveryBridges } from '../../v5/recovery/RecoveryScreen';
import { RECOVERY_COPY } from '../../v5/recovery/recovery-copy';

export const RECOVERY_PATH = '/app/manager/recovery';
const MANAGER_ROLES: ReadonlySet<string> = new Set(['manager', 'admin']);

/**
 * RT-441 (RT-116 §5) — the manager dashboard's way into
 * `/app/manager/recovery`. A session main admitted in RECOVERY MODE is sent
 * there at once: it can do nothing else until the stuck payment is resolved.
 * Navigation only: nothing for a cashier; the route and main re-check.
 */
export function RecoveryLink(): JSX.Element | null {
  const role = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.role : null,
  );
  const navigate = useNavigate();
  const isManager = role !== null && MANAGER_ROLES.has(role);

  useEffect(() => {
    if (!isManager) return;
    const bridges = windowRecoveryBridges();
    if (bridges === null) return;
    let live = true;
    bridges.recovery.listHeld().then(
      (answer) => {
        if (live && answer.kind === 'held' && answer.recovery_mode) {
          void navigate(RECOVERY_PATH, { replace: true });
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [isManager, navigate]);

  if (!isManager) return null;
  return (
    <p data-testid="dashboard-recovery-link">
      <Link to={RECOVERY_PATH}>{RECOVERY_COPY.link}</Link>
    </p>
  );
}
