import { useEffect, useState, type JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { Role } from '../../../shared/operator/role';
import type { ShiftCashupBridgeAPI } from '../../../shared/shift-cashup/types';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { callShift, resolveShiftBridge } from './shift-bridge';
import { SHIFT_COPY } from './shift-copy';
import './shift.css';

interface Props {
  /** Tests inject a bridge (null = none); production reads `window.api`. */
  readonly bridge?: ShiftCashupBridgeAPI | null;
}

const SHIFT_PATH = '/app/shift';
const MANAGER_PATH = '/app/shift/manager';

/**
 * RT-17 slice 4 part 3 — the shift notice in the v5 frame.
 *
 * The "shift required" gate (10919): a cashier with no open shift sees a
 * persistent banner with the way to open one. Selling is NOT blocked: 10919
 * names the gate but does not say it stops a sale, and blocking would also
 * strand a manager (who cannot open a shift on the device path). With an
 * open shift (or an unreadable status) the notice is one quiet link to the
 * shift screen; a manager or admin gets the way to the shift status instead,
 * and no status read. With the flag off (or not yet hydrated) nothing renders
 * and nothing is called.
 */
export function ShiftNotice({ bridge }: Props): JSX.Element | null {
  const enabled = useFeatureFlagsStore((s) => s.shiftCashup);
  const role = useOperatorSessionStore((s) =>
    s.state.kind === 'signedIn' ? s.state.session.role : null,
  );
  const api = resolveShiftBridge(bridge);
  if (!enabled || role === null || api === null) return null;
  return <RoutedShiftNotice bridge={api} role={role} />;
}

/** Flag on, signed in: the notice for this screen (none on the shift screens). */
function RoutedShiftNotice(props: {
  bridge: ShiftCashupBridgeAPI;
  role: Role;
}): JSX.Element | null {
  const { pathname } = useLocation();
  if (pathname.startsWith(SHIFT_PATH)) return null;
  if (props.role !== 'cashier') {
    return (
      <p className="v5-shift-notice">
        <Link to={MANAGER_PATH}>{SHIFT_COPY.managerLink}</Link>
      </p>
    );
  }
  return <CashierShiftNotice bridge={props.bridge} pathname={pathname} />;
}

type Gate = 'unknown' | 'none' | 'open';

function CashierShiftNotice(props: {
  bridge: ShiftCashupBridgeAPI;
  pathname: string;
}): JSX.Element | null {
  const [gate, setGate] = useState<Gate>('unknown');
  const { bridge, pathname } = props;

  // Re-read on every screen change, so the gate follows an open or a close.
  useEffect(() => {
    let live = true;
    void callShift(() => bridge.status()).then((answer) => {
      if (!live) return;
      const none = answer.kind === 'status' && answer.status.openShift === null;
      setGate(none ? 'none' : 'open');
    });
    return () => {
      live = false;
    };
  }, [bridge, pathname]);

  if (gate === 'unknown') return null;
  if (gate === 'open') {
    return (
      <p className="v5-shift-notice">
        <Link to={SHIFT_PATH}>{SHIFT_COPY.manageShift}</Link>
      </p>
    );
  }
  return (
    <div className="v5-shift-banner" role="status" data-testid="shift-gate-banner">
      <p>{SHIFT_COPY.gateBanner}</p>
      <Link className="v5-shift-btn v5-shift-btn--primary" to={SHIFT_PATH}>
        {SHIFT_COPY.gateAction}
      </Link>
    </div>
  );
}
