import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { PAIRING_IPC_CHANNELS, type PairingRecheckResult } from '../../shared/pairing-types.js';
import type { PairingStore } from '../pairing/store.js';
import type { PairingService } from '../pairing/service.js';

/**
 * 002-terminal-pairing T013 + T025 — `pairing:*` IPC handlers.
 *
 * One registration entry-point per namespace. US1 wired
 * `pairing:get-status`; US2 (T025) adds `pairing:submit`.
 *
 * Both store and service are INJECTED so unit tests don't have to
 * construct a real SecretStore + DB + network. Mirrors the Phase 9
 * `app:config` pattern.
 *
 * Security policy:
 *   - GET_STATUS: returns `PairingStatus` unchanged. The type carries no
 *     token field by design (data-model.md § "Status derivation logic"
 *     + pairing-types.ts:21-35) — the renderer never sees a
 *     device_token even on the success branch.
 *   - SUBMIT: validates `pairing_code` is a string BEFORE crossing the
 *     trust boundary into the service. The service result
 *     (`PairingSubmitResult`) is forwarded unchanged — its success
 *     branch type explicitly omits `device_token`, so even a future
 *     bug in the service cannot leak the token through this channel.
 *   - The boundary rejection MUST NOT echo the renderer-supplied
 *     payload (which could itself be a sensitive object). The thrown
 *     Error message is a stable, payload-free string.
 *   - RECHECK (RT-215 10897-A): the renderer can only TRIGGER the
 *     "Check again"; any argument it sends is ignored, and the answer is
 *     `{ outcome }` only — the token never crosses the bridge.
 */

export interface PairingHandlerDeps {
  store: PairingStore;
  service: PairingService;
  /** RT-215 10897-A — the "Check again" (`pairing:recheck`); registered when given. */
  recheck?: () => Promise<PairingRecheckResult>;
}

export function registerPairingHandlers(ipcMain: IpcMain, deps: PairingHandlerDeps): void {
  const { store, service, recheck } = deps;

  ipcMain.handle(PAIRING_IPC_CHANNELS.GET_STATUS, () => store.getStatus());

  ipcMain.handle(PAIRING_IPC_CHANNELS.SUBMIT, (_event: IpcMainInvokeEvent, code: unknown) => {
    if (typeof code !== 'string') {
      // Defensive boundary check. The service ALSO checks this, but we
      // fail BEFORE crossing the trust boundary so a malicious or buggy
      // renderer cannot exercise the service with a non-string. The
      // message is intentionally payload-free per Constitution VII.
      throw new TypeError(
        `pairing:submit: pairing_code must be a string (received ${typeof code}).`,
      );
    }
    // Service contract: NEVER rejects for any backend or network outcome.
    // The result is a typed `PairingSubmitResult` whose success branch
    // omits `device_token` by construction — safe to forward verbatim.
    return service.submit(code);
  });

  if (recheck !== undefined) {
    ipcMain.handle(PAIRING_IPC_CHANNELS.RECHECK, () => recheck());
  }
}
