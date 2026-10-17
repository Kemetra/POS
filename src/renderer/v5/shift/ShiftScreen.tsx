import type { JSX, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import type { Role } from '../../../shared/operator/role';
import type { ShiftCashupBridgeAPI } from '../../../shared/shift-cashup/types';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { Notice } from '../foundation/Notice';
import { ScreenSection } from '../foundation/ScreenSection';
import { resolveShiftBridge } from './shift-bridge';
import { SHIFT_COPY } from './shift-copy';
import './shift.css';

interface Props {
  readonly title: string;
  /** Tests inject a bridge (null = none); production reads `window.api`. */
  readonly bridge?: ShiftCashupBridgeAPI | null | undefined;
  /** Roles that may see the screen; any other leaves for `/app`. */
  readonly allow?: ReadonlyArray<Role>;
  readonly children: (bridge: ShiftCashupBridgeAPI) => ReactNode;
}

/**
 * RT-17 slice 4 part 3 — the renderer's fail-closed gate for a shift screen,
 * on the G-6 page header (RT-658: the ScreenSection h1, no sunken titlebar).
 * Signed out: nothing (the operator guard owns sign-in). Flag off or not yet
 * hydrated, or a role not allowed: the screen is not shown at all — it leaves
 * for `/app` before any call. Main re-checks the flag, the session and the
 * role on every `shiftCashup.*` call, and registers no handler with the flag
 * off.
 */
export function ShiftScreen(props: Props): JSX.Element | null {
  const enabled = useFeatureFlagsStore((s) => s.shiftCashup);
  const role = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.role : null,
  );
  if (role === null) return null;
  const allowed = props.allow === undefined || props.allow.includes(role);
  if (!enabled || !allowed) return <Navigate to="/app" replace />;
  const api = resolveShiftBridge(props.bridge);
  return (
    <ScreenSection title={props.title}>
      <div className="v5-shift-page">
        {api === null ? (
          <div className="v5-shift-state">
            <Notice tone="info">{SHIFT_COPY.bridgeMissing}</Notice>
          </div>
        ) : (
          props.children(api)
        )}
      </div>
    </ScreenSection>
  );
}
