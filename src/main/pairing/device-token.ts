import type { SecretKey, SecretStore } from '../../shared/secret-store.js';

import type { DeviceRevocationStore, PairingStore } from './store.js';
import { tokenBoundTo } from './token-binding.js';

/**
 * RT-215 — the ONE reader of the device token for SENDING it to Backend-Core.
 *
 * Returns the token only while `getStatus()` is `paired`. Every other status
 * — unpaired, an orphan in either direction, a decrypt failure and, above
 * all, `device_revoked` — returns null, so a device-bearer client sends
 * nothing (it answers `no_token` / `failed` locally). After a confirmed
 * revocation the token stays sealed in the SecretStore (a re-pair overwrites
 * it) but is never sent again (RT-215 decision 3) — except by the ONE
 * user-initiated "Check again", through {@link createRevocationRecheckTokenRead}.
 *
 * RT-306: the sealed token is handed out only while it is bound to the
 * pairing `getStatus()` reported (see `token-binding.ts`); a token sealed for
 * another pairing, or an unreadable one, is null.
 *
 * Never throws: a failing status read or token read is null. The token is
 * returned to an in-process caller only and is never logged here.
 */
export interface SendableDeviceTokenReaderDeps {
  /**
   * `isDeviceRevoked` (the real store has it) is re-checked SYNCHRONOUSLY
   * after the last await, right before the token is handed out (Codex P1
   * 4186568808): a revocation latched while a read was pending wins.
   */
  pairingStore: Pick<PairingStore, 'getStatus'> &
    Partial<Pick<DeviceRevocationStore, 'isDeviceRevoked'>>;
  secretStore: Pick<SecretStore, 'get'>;
  deviceTokenKey: SecretKey;
}

export function createSendableDeviceTokenReader(
  deps: SendableDeviceTokenReaderDeps,
): () => Promise<string | null> {
  const read = createSendableDeviceTokenRead(deps);
  return async (): Promise<string | null> => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
}

/**
 * RT-215 × RT-224 — the same sendable read, for a caller with its own
 * never-reject wrapper and failure log (the sale-sync device path, #547's
 * `createSaleSyncDeviceTokenReader`): a failing status or token read REJECTS
 * instead of reading as null. Every other rule is identical: null unless
 * `paired`, and null when the revocation latched during the reads.
 */
export function createSendableDeviceTokenRead(
  deps: SendableDeviceTokenReaderDeps,
): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    const status = await deps.pairingStore.getStatus();
    if (status.kind !== 'paired') return null;
    const sealed = await deps.secretStore.get(deps.deviceTokenKey);
    // Nothing awaits between this check and handing the token out.
    if (deps.pairingStore.isDeviceRevoked?.() === true) return null;
    return tokenBoundTo(sealed, status);
  };
}

/**
 * RT-215 10897-A (owner approval 10906) — the ONE deliberate exception to "a
 * revoked token is never sent": the sealed token for the single roster call of
 * a user-initiated "Check again" on `/pairing`. Used ONLY by that flow; never
 * automatic, never on a timer, never at boot. The default readers above stay
 * null while revoked.
 *
 * Returns the token ONLY while the pairing is device-revoked (re-checked after
 * the read, so a re-pair that lands meanwhile is not sent through here); null
 * otherwise, and for an absent, empty or unreadable token, or one sealed for
 * another pairing (RT-306). Never throws; never logs.
 */
export interface RevocationRecheckTokenReadDeps {
  pairingStore: Pick<DeviceRevocationStore, 'isDeviceRevoked' | 'getStoredPairingBinding'>;
  secretStore: Pick<SecretStore, 'get'>;
  deviceTokenKey: SecretKey;
}

export function createRevocationRecheckTokenRead(
  deps: RevocationRecheckTokenReadDeps,
): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    if (!deps.pairingStore.isDeviceRevoked()) return null;
    let sealed: string | null;
    try {
      sealed = await deps.secretStore.get(deps.deviceTokenKey);
    } catch {
      return null;
    }
    // Nothing awaits between this check and handing the token out.
    if (!deps.pairingStore.isDeviceRevoked()) return null;
    return tokenBoundTo(sealed, deps.pairingStore.getStoredPairingBinding());
  };
}
