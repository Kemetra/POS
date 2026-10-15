import type { JSX } from 'react';

import { PairingForm } from './PairingForm';
import { InvalidStateBanner } from './InvalidStateBanner';
import { RevocationRecheck } from './RevocationRecheck';
import { EntryCardIcon, EntryCardScreen } from '../../v5/entry/EntryCard';
import { PAIRING_COPY } from '../../v5/entry/entry-copy';
import type { PairingBridgeAPI, PreloadBridgeAPI } from '../../../shared/bridge-api';
import type { PairingStatus } from '../../../shared/pairing-types';

/**
 * 002-terminal-pairing T031 — `/pairing` route.
 *
 * Hosts `PairingForm`, the only input surface on this route. Preserves
 * the US1 testid + `data-invalid-reason` attribute so:
 *   - the renderer router test (PR #16) keeps asserting the routing
 *     decision via `data-testid="route-pairing"`,
 *   - the future US7 banner (T070) reads the reason from the data
 *     attribute without re-querying the bridge.
 *
 * NO outcome-specific copy (T074 / Phase Final lands the message
 * dictionary). The form is self-contained: it handles in-flight
 * disable, success navigation, and re-enable on failure.
 */

export interface PairingScreenProps {
  /**
   * Present only when the boot router landed here because
   * `pairingStore.getStatus()` returned `kind: 'invalid'`. US7 will
   * turn this into an in-app diagnostic banner; US2 just preserves the
   * attribute on the route element so the router test keeps working.
   */
  invalidReason?: Extract<PairingStatus, { kind: 'invalid' }>['reason'];

  /**
   * Bridge to the main process. Tests inject a fake; production reads
   * from `window.api.pairing`. Forwarded to PairingForm so a single
   * prop drilling chain decides where the bridge comes from.
   */
  pairing?: PairingBridgeAPI;
}

export function PairingScreen(props: Readonly<PairingScreenProps>): JSX.Element {
  // Only set the data attribute when defined — exactOptionalPropertyTypes
  // forbids `attribute: undefined`.
  const reasonAttr =
    props.invalidReason !== undefined ? { 'data-invalid-reason': props.invalidReason } : {};

  // Forward the bridge as `pairing={...}` only when defined — the form
  // accepts `pairing?: PairingBridgeAPI` and falls back to `window.api`
  // when omitted. exactOptionalPropertyTypes forbids `{ pairing: undefined }`.
  const formProps = props.pairing !== undefined ? { pairing: props.pairing } : {};
  // RT-215 10897-A — "Check again" only while the terminal is device-revoked.
  const recheckVia =
    props.invalidReason === 'device_revoked' ? recheckBridge(props.pairing) : undefined;
  // RT-244 PR2 (G-1 «Pairing»): one centred card — the heading and hint, the
  // invalid-state notice when the router names a reason, the form, and the
  // "Check again" while device-revoked.
  return (
    <EntryCardScreen rootProps={{ 'data-testid': 'route-pairing', ...reasonAttr }}>
      <div className="v5-entry__card">
        <EntryCardIcon name="link" />
        <div className="v5-entry__card-head">
          <h1 id="pairing-title" className="v5-entry__card-title">
            {PAIRING_COPY.title}
          </h1>
          <p id="pairing-hint" className="v5-entry__card-hint">
            {PAIRING_COPY.hint}
          </p>
        </div>
        {props.invalidReason !== undefined && <InvalidStateBanner reason={props.invalidReason} />}
        <PairingForm {...formProps} labelledBy="pairing-title" hintId="pairing-hint" />
        {recheckVia !== undefined && <RevocationRecheck pairing={recheckVia} />}
      </div>
    </EntryCardScreen>
  );
}

/** The bridge, when it offers the "Check again" (an older preload / a test fake may not). */
function recheckBridge(pairing: PairingBridgeAPI | undefined): PairingBridgeAPI | undefined {
  const bridge = pairing ?? (window as unknown as { api?: PreloadBridgeAPI }).api?.pairing;
  return bridge?.recheckRevocation !== undefined ? bridge : undefined;
}
