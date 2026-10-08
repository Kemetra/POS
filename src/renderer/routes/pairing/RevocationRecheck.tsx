import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { RECHECK_STILL_REVOKED_MESSAGE, RECHECK_UNREACHABLE_MESSAGE } from './messages';
import type { PairingBridgeAPI } from '../../../shared/bridge-api';
import type { PairingRecheckOutcome } from '../../../shared/pairing-types';

/**
 * RT-215 10897-A (owner approval 10906) — the ONE user-initiated "Check
 * again" on `/pairing`, rendered by `PairingScreen` only while the terminal is
 * device-revoked.
 *
 * One press asks main for ONE roster probe (`pairing:recheck`); the renderer
 * never sees the token. `cleared` leaves `/pairing` for `/paired`, as a
 * successful pairing does; `still_revoked` and `unreachable` keep the terminal
 * revoked and say so. One check at a time: the button is disabled while a
 * check runs and for {@link RECHECK_COOLDOWN_MS} after it.
 */

/** The short UI cooldown after each attempt. */
export const RECHECK_COOLDOWN_MS = 5_000;

const MESSAGE: Readonly<Record<Exclude<PairingRecheckOutcome, 'cleared'>, string>> = {
  still_revoked: RECHECK_STILL_REVOKED_MESSAGE,
  unreachable: RECHECK_UNREACHABLE_MESSAGE,
};

async function outcomeOf(pairing: PairingBridgeAPI): Promise<PairingRecheckOutcome> {
  try {
    const result = await pairing.recheckRevocation?.();
    return result?.outcome ?? 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export function RevocationRecheck(props: { pairing: PairingBridgeAPI }): JSX.Element {
  const { pairing } = props;
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!coolingDown) return;
    const timer = setTimeout(() => {
      setCoolingDown(false);
    }, RECHECK_COOLDOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [coolingDown]);

  async function check(): Promise<void> {
    if (checking || coolingDown) return;
    setChecking(true);
    setMessage(null);
    const outcome = await outcomeOf(pairing);
    setChecking(false);
    if (outcome === 'cleared') {
      void navigate('/paired', { replace: true });
      return;
    }
    setCoolingDown(true);
    setMessage(MESSAGE[outcome]);
  }

  return (
    <div className="pairing-screen__actions">
      <button
        type="button"
        className="btn btn--secondary btn--lg"
        disabled={checking || coolingDown}
        onClick={() => {
          void check();
        }}
      >
        {checking ? 'Checking…' : 'Check again'}
      </button>
      {message !== null ? (
        <p role="status" data-testid="recheck-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}
