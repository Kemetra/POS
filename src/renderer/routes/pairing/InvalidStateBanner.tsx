import type { JSX } from 'react';

import type { PairingStatus } from '../../../shared/pairing-types';

type InvalidReason = Extract<PairingStatus, { kind: 'invalid' }>['reason'];

const MESSAGES: Record<InvalidReason, string> = {
  missing_token: 'This terminal needs to be paired again. The secure token is missing.',
  orphaned_row: 'This terminal needs to be paired again. Local assignment data is incomplete.',
  decrypt_failed: 'This terminal needs to be paired again. Secure token recovery failed.',
  // RT-215 — the device credential was confirmed revoked by Backend-Core.
  // Sales are never reversed or discarded (RT-24 / RT-138 L6): unsent ones
  // stay on the terminal, held from the previous pairing (RT-221).
  device_revoked:
    'This terminal’s access was revoked. Unsent sales are kept on this terminal. Enter a new pairing code from the admin portal to continue.',
};

interface InvalidStateBannerProps {
  reason: InvalidReason;
}

export function InvalidStateBanner({ reason }: InvalidStateBannerProps): JSX.Element {
  return (
    <div role="alert" data-testid="invalid-state-banner">
      {MESSAGES[reason]}
    </div>
  );
}
