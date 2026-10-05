import { useEffect, useRef, type JSX } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { PairingScreen } from './PairingScreen';
import type { PairingBridgeAPI } from '../../../shared/bridge-api';
import {
  PAIRING_INVALID_REASONS,
  type PairingInvalidReason,
  type PairingStatusChangedEvent,
} from '../../../shared/pairing-types';

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
 * (`device_revoked_at` on the pairing row), and starts at `/pairing`. A push
 * sent before this layout mounts is kept by the relay (Codex P2 4186254473).
 * The layout wraps EVERY route (/, /pairing, /paired, /sign-in, /app/*), so a
 * revoked terminal reaches recovery from wherever it sits.
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

/**
 * Codex P2 4186254473 — the ONE `pairing:status-changed` subscription is
 * registered by `AppRouter` BEFORE its boot status read, and feeds this relay.
 * The recovery layout below mounts only after that read; until it attaches,
 * the relay keeps the latest invalid event (a later `paired`/`unpaired` clears
 * it) and hands it over on attach, so no push is lost and none is replayed.
 */
export interface PairingPushRelay {
  deliver(event: PairingStatusChangedEvent): void;
  /** Attach the handler; a missed invalid event is delivered at once. Returns detach. */
  attach(handler: (event: PairingStatusChangedEvent) => void): () => void;
}

export function createPairingPushRelay(): PairingPushRelay {
  let handler: ((event: PairingStatusChangedEvent) => void) | null = null;
  let missed: PairingStatusChangedEvent | null = null;
  return {
    deliver(event) {
      if (handler !== null) {
        handler(event);
        return;
      }
      missed = event.kind === 'invalid' ? event : null;
    },
    attach(next) {
      handler = next;
      const pending = missed;
      missed = null;
      if (pending !== null) next(pending);
      return () => {
        if (handler === next) handler = null;
      };
    },
  };
}

/**
 * The ONE `pairing:status-changed` subscription, feeding a relay that lives
 * as long as the component. Call it BEFORE any effect that reads the boot
 * status: effects run in declaration order, so it subscribes first.
 */
export function usePairingPushRelay(pairing: PairingBridgeAPI): PairingPushRelay {
  const relay = useRef<PairingPushRelay | null>(null);
  relay.current ??= createPairingPushRelay();
  const current = relay.current;
  useEffect(() => {
    const unsubscribe = pairing.onStatusChanged?.((event) => {
      current.deliver(event);
    });
    return () => {
      unsubscribe?.();
    };
  }, [pairing, current]);
  return current;
}

export function PairingRecoveryListener(props: { relay: PairingPushRelay }): JSX.Element {
  const navigate = useNavigate();
  const { relay } = props;
  useEffect(
    () =>
      relay.attach((event) => {
        if (event.kind !== 'invalid') return;
        const state: PairingRouteState = { invalidReason: event.reason };
        void navigate('/pairing', { replace: true, state });
      }),
    [relay, navigate],
  );
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
