import type { SecretKey, SecretStore } from '../../shared/secret-store.js';

import type { PairingStore } from './store.js';

/**
 * RT-215 — the ONE reader of the device token for SENDING it to Backend-Core.
 *
 * Returns the token only while `getStatus()` is `paired`. Every other status
 * — unpaired, an orphan in either direction, a decrypt failure and, above
 * all, `device_revoked` — returns null, so a device-bearer client sends
 * nothing (it answers `no_token` / `failed` locally). After a confirmed
 * revocation the token stays sealed in the SecretStore (a re-pair overwrites
 * it) but is never sent again (RT-215 decision 3).
 *
 * Never throws: a failing status read or token read is null. The token is
 * returned to an in-process caller only and is never logged here.
 */
export interface SendableDeviceTokenReaderDeps {
  pairingStore: Pick<PairingStore, 'getStatus'>;
  secretStore: Pick<SecretStore, 'get'>;
  deviceTokenKey: SecretKey;
}

export function createSendableDeviceTokenReader(
  deps: SendableDeviceTokenReaderDeps,
): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    try {
      const status = await deps.pairingStore.getStatus();
      if (status.kind !== 'paired') return null;
      const token = await deps.secretStore.get(deps.deviceTokenKey);
      return token !== null && token.length > 0 ? token : null;
    } catch {
      return null;
    }
  };
}
