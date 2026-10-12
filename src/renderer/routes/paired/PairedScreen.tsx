import { useEffect, useState, type JSX } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { EntryCardIcon, EntryCardScreen } from '../../v5/entry/EntryCard';
import { READY_COPY } from '../../v5/entry/entry-copy';
import type { PairingBridgeAPI, PreloadBridgeAPI } from '../../../shared/bridge-api';
import type { PairingStatus } from '../../../shared/pairing-types';

/**
 * 002-terminal-pairing T033 — `/paired` route.
 *
 * Self-fetches its data via `bridge.pairing.getStatus()` (Option B
 * from the readiness review). This decouples the route from the boot
 * router's state machine: the form's `navigate('/paired')` lands here,
 * the screen re-fetches, and the operator sees the fresh assignment.
 *
 * Defensive recovery: if `getStatus()` returns `unpaired` or `invalid`
 * (or rejects), the screen redirects to `/pairing`. US7 (T070) lands
 * the actual diagnostic banner; US2 just gets the operator back to a
 * usable surface.
 *
 * Security policy:
 *   - The `paired` PairingStatus branch type explicitly omits
 *     `device_token`. This component only reads terminal_label /
 *     paired_at — all human-facing configuration, no identifiers or
 *     secrets are rendered in visible text or DOM attributes.
 *   - The bridge call goes through the typed preload, which
 *     in turn invokes the main-process IPC handler that already
 *     omits the token from the result envelope.
 *   - Tests assert (T032) that no `device_token` field name and no
 *     sentinel-token string ever appear in the rendered tree.
 */

export interface PairedScreenProps {
  /**
   * Bridge to the main process. Tests inject a fake; production reads
   * from `window.api.pairing`.
   */
  pairing?: PairingBridgeAPI;
}

type ScreenState =
  | { phase: 'loading' }
  | { phase: 'paired'; status: Extract<PairingStatus, { kind: 'paired' }> }
  | { phase: 'redirect-to-pairing' };

export function PairedScreen(props: PairedScreenProps): JSX.Element {
  const [state, setState] = useState<ScreenState>({ phase: 'loading' });
  const pairing = props.pairing ?? readBridge();
  const navigate = useNavigate();

  useEffect(() => {
    const guard = { cancelled: false };
    void (async () => {
      let next: ScreenState;
      try {
        const status = await pairing.getStatus();
        if (status.kind === 'paired') {
          next = { phase: 'paired', status };
        } else {
          // unpaired or invalid → recovery is to land on /pairing.
          next = { phase: 'redirect-to-pairing' };
        }
      } catch {
        // Bridge rejection: same recovery surface (operator re-pairs).
        // We DO NOT include the rejection's value in any log emission
        // here — Constitution VII (no secret-shaped data through the
        // logger from a typed error path).
        next = { phase: 'redirect-to-pairing' };
      }
      if (!guard.cancelled) setState(next);
    })();
    return () => {
      guard.cancelled = true;
    };
  }, [pairing]);

  if (state.phase === 'loading') {
    return <main data-testid="route-paired-loading" />;
  }
  if (state.phase === 'redirect-to-pairing') {
    return <Navigate to="/pairing" replace />;
  }

  const { status } = state;
  // RT-244 PR2 (G-1 «Ready»): the M-F1 sentence, the terminal label as the one
  // fact, one commit. A neutral state, not a success colour. The label is admin
  // free text, so it is isolated in <bdi>. data-terminal-label is a
  // human-friendly label, not a backend identifier — intentionally retained.
  return (
    <EntryCardScreen
      rootProps={{ 'data-testid': 'route-paired', 'data-terminal-label': status.terminal_label }}
    >
      <section className="v5-entry__card" aria-labelledby="ready-title">
        <EntryCardIcon name="terminal" />
        <h1 id="ready-title" className="v5-entry__card-title">
          {READY_COPY.title}
        </h1>
        <dl className="v5-entry__facts">
          <dt>{READY_COPY.terminal}</dt>
          <dd>
            <bdi>{status.terminal_label}</bdi>
          </dd>
        </dl>
        {/* T054 — O2 resolution: Continue navigates to /app/dashboard.
            Boot router gate is NOT modified. No IPC / bridge call. */}
        <button
          type="button"
          className="v5-entry__btn v5-entry__btn--primary v5-entry__commit"
          data-testid="paired-continue"
          autoFocus
          onClick={() => void navigate('/app/dashboard')}
        >
          {READY_COPY.continue}
        </button>
      </section>
    </EntryCardScreen>
  );
}

/**
 * Read `window.api.pairing` defensively. Mirrors the helper in
 * PairingForm.tsx — see that file for the trade-off on test/prod
 * indirection.
 */
function readBridge(): PairingBridgeAPI {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api) {
    throw new Error('PairedScreen: window.api missing — preload bridge not initialised.');
  }
  return api.pairing;
}
