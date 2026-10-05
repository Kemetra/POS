import { useEffect, type JSX } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { PairingScreen } from './PairingScreen';
import type { PairingBridgeAPI } from '../../../shared/bridge-api';
import { PAIRING_INVALID_REASONS, type PairingInvalidReason } from '../../../shared/pairing-types';

/**
 * RT-215 — the renderer half of pairing recovery.
 *
 * Main pushes `pairing:status-changed` once a confirmed device revocation
 * reaches its routing point: there is no session, or the latched session
 * ended at its first safe point (a live sale is never interrupted — RT-24).
 * On an `invalid` push this layout route moves the terminal to `/pairing`,
 * carrying the reason in the location state so the recovery copy shows. Any
 * other push (`paired`, `unpaired`) does not navigate: a successful pairing
 * already navigates from the form.
 *
 * At boot no push is needed: the router reads `getStatus()`, which is durable
 * (`device_revoked_at` on the pairing row), and starts at `/pairing`.
 */

/** Location state that carries a pushed invalid reason to `/pairing`. */
interface PairingRouteState {
  invalidReason: PairingInvalidReason;
}

const REASONS: ReadonlySet<string> = new Set(PAIRING_INVALID_REASONS);

function pushedReason(state: unknown): PairingInvalidReason | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const reason = (state as { invalidReason?: unknown }).invalidReason;
  return typeof reason === 'string' && REASONS.has(reason)
    ? (reason as PairingInvalidReason)
    : undefined;
}

export function PairingRecoveryListener(props: { pairing: PairingBridgeAPI }): JSX.Element {
  const navigate = useNavigate();
  const { pairing } = props;
  useEffect(() => {
    const unsubscribe = pairing.onStatusChanged?.((event) => {
      if (event.kind !== 'invalid') return;
      const state: PairingRouteState = { invalidReason: event.reason };
      void navigate('/pairing', { replace: true, state });
    });
    return () => {
      unsubscribe?.();
    };
  }, [pairing, navigate]);
  return <Outlet />;
}

/**
 * `/pairing`: the reason pushed at runtime wins over the one read at boot.
 */
export function PairingRoute(props: {
  pairing: PairingBridgeAPI;
  bootReason?: PairingInvalidReason;
}): JSX.Element {
  const location = useLocation();
  const reason = pushedReason(location.state) ?? props.bootReason;
  return reason !== undefined ? (
    <PairingScreen pairing={props.pairing} invalidReason={reason} />
  ) : (
    <PairingScreen pairing={props.pairing} />
  );
}
