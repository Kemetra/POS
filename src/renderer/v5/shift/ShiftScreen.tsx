import type { JSX, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import type { Role } from '../../../shared/operator/role';
import type { ShiftCashupBridgeAPI } from '../../../shared/shift-cashup/types';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { resolveShiftBridge } from './shift-bridge';
import { SHIFT_COPY } from './shift-copy';
import './shift.css';

interface Props {
  readonly title: string;
  readonly titleId: string;
  /** Tests inject a bridge (null = none); production reads `window.api`. */
  readonly bridge?: ShiftCashupBridgeAPI | null | undefined;
  /** Roles that may see the screen; any other leaves for `/app`. */
  readonly allow?: ReadonlyArray<Role>;
  readonly children: (bridge: ShiftCashupBridgeAPI) => ReactNode;
}

/**
 * RT-17 slice 4 part 3 — the renderer's fail-closed gate for a shift screen.
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
    <section className="v5-shift" aria-labelledby={props.titleId}>
      <div className="v5-shift-titlebar">
        <h1 id={props.titleId}>{props.title}</h1>
      </div>
      {api === null ? (
        <p className="v5-shift-message">{SHIFT_COPY.bridgeMissing}</p>
      ) : (
        props.children(api)
      )}
    </section>
  );
}

/** A refusal (or rejected call) in the region that caused it. */
export function ShiftAlert({ message }: { message: string | null }): JSX.Element | null {
  if (message === null) return null;
  return (
    <p className="v5-shift-alert" role="alert">
      {message}
    </p>
  );
}
