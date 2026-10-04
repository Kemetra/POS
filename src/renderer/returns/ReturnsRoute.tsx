import type { JSX } from 'react';

import type { Role } from '../../shared/operator/role.js';
import type { ReturnsBridgeAPI } from '../../shared/returns/types.js';
import { Workspace } from '../shell/regions/Workspace';
import { useFeatureFlagsStore } from '../stores/feature-flags-store.js';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../stores/operator-session-store.js';
import { windowReturnsBridge } from './returns-bridge.js';
import { OUTCOME_COPY, refusalMessage } from './returns-messages.js';
import { ReturnsScreen } from './ReturnsScreen';
import './returns.css';

/**
 * RT-15 S3 — `/app/returns`: the manager/admin return flow (replaces the
 * placeholder).
 *
 * The router already guards the route to manager/admin and the nav hides it
 * from cashiers; main re-checks flag, session and role on every call (D-b).
 * This screen adds the renderer's own fail-closed gate (A6, A7): with no
 * returns role, the flag off (or not yet hydrated) or no returns bridge it
 * shows why and makes no call at all.
 *
 * The flow is keyed by the operator session id, so a different operator never
 * inherits the previous one's sale, quote or outcome (S1, S2).
 */
export interface ReturnsRouteProps {
  /** Tests inject a bridge (null = no returns namespace); production reads window.api. */
  readonly bridge?: ReturnsBridgeAPI | null;
}

const RETURNS_ROLES: ReadonlySet<Role> = new Set<Role>(['manager', 'admin']);

function gateMessage(
  session: OperatorSessionView,
  enabled: boolean,
  bridge: ReturnsBridgeAPI | null,
): string | null {
  if (!RETURNS_ROLES.has(session.role)) return refusalMessage('role_denied');
  if (!enabled) return refusalMessage('feature_disabled');
  return bridge === null ? OUTCOME_COPY.bridgeMissing : null;
}

export function ReturnsRoute({ bridge }: ReturnsRouteProps): JSX.Element | null {
  const session = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session : null,
  );
  const enabled = useFeatureFlagsStore((s) => s.returns);
  const api = bridge === undefined ? windowReturnsBridge() : bridge;
  if (session === null) return null;
  const blocked = gateMessage(session, enabled, api);

  return (
    <Workspace title="المرتجعات">
      <div className="rt-returns">
        {blocked !== null || api === null ? (
          <p className="rt-returns__policy" role="status">
            {blocked}
          </p>
        ) : (
          <ReturnsScreen key={session.id} bridge={api} />
        )}
      </div>
    </Workspace>
  );
}
