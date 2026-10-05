/**
 * RT-224 step 2 (Codex P2 on #547) — the sale-sync read of the device token.
 *
 * The device-path sale capture needs the paired terminal's device token, read in
 * process from the OS secret store (DPAPI / keychain) on every POST. That read can
 * fail transiently. A rejection here must never abort the drain — which would
 * also stop manager sales that could go out under an envelope — and must never
 * break the client's never-reject contract. So any failure reads as "no device
 * credential" (`null`): cashier sales stay queued, envelope traffic continues.
 *
 * `onReadFailure` fires once per failure episode (re-armed by a read that
 * completes) and receives nothing: no token, no error text (P7).
 *
 * RT-215 × RT-224: production reads through RT-215's
 * `createSendableDeviceTokenRead` (null unless paired, null once revoked —
 * re-checked synchronously after its last await), which already gates on the
 * pairing, so `isPaired` is optional. This wrapper keeps the never-reject
 * contract and the failure log around it.
 */
export interface SaleSyncDeviceTokenReaderDeps {
  /** Whether the terminal is paired right now. Omitted when `readToken` gates on it. */
  isPaired?: () => Promise<boolean>;
  /** The device token to send (may reject on a secret-store failure). */
  readToken: () => Promise<string | null | undefined>;
  /** Called once per failure episode, with no arguments. */
  onReadFailure?: () => void;
}

export function createSaleSyncDeviceTokenReader(
  deps: SaleSyncDeviceTokenReaderDeps,
): () => Promise<string | null> {
  let failing = false;

  function reportFailure(): void {
    if (failing) return;
    failing = true;
    try {
      deps.onReadFailure?.();
    } catch {
      // A failing log sink must not turn a credential miss into a rejection.
    }
  }

  return async () => {
    try {
      const paired = deps.isPaired === undefined || (await deps.isPaired());
      const token = paired ? ((await deps.readToken()) ?? null) : null;
      failing = false;
      return token !== null && token.length > 0 ? token : null;
    } catch {
      reportFailure();
      return null;
    }
  };
}
