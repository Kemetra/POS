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
 * RT-215 (POS #546): once it merges, `readToken`/`isPaired` become its
 * `createSendableDeviceTokenReader` (null unless paired); keep this never-reject
 * wrapper around it.
 */
export interface SaleSyncDeviceTokenReaderDeps {
  /** Whether the terminal is paired right now. */
  isPaired: () => Promise<boolean>;
  /** The stored device token (may reject on a secret-store failure). */
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
      const token = (await deps.isPaired()) ? ((await deps.readToken()) ?? null) : null;
      failing = false;
      return token !== null && token.length > 0 ? token : null;
    } catch {
      reportFailure();
      return null;
    }
  };
}
