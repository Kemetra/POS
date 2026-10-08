import type { JSX } from 'react';

import { AppRouter } from './router';
import { SessionLockGate } from './session/SessionLockGate';
import { ScanGuardHost } from './scan/ScanGuardHost';
import type { PreloadBridgeAPI } from '../shared/bridge-api';

/**
 * 002-terminal-pairing T016 — App root.
 * 004-operator-session T032 — wires the operator bridge alongside
 * pairing so `/sign-in` is mounted in production.
 *
 * Tests render `AppRouter` directly with injected bridges, so this
 * component stays a one-liner.
 */
export default function App(): JSX.Element {
  const bridge = (window as unknown as { api: PreloadBridgeAPI }).api;
  // RT-117 — the inactivity lock screen sits above every route and keeps the
  // routed app mounted (inert) underneath, so a locked sale is preserved.
  return (
    <>
      {/* RT-239: one scan guard for the whole app, including sign-in and the lock screen. */}
      <ScanGuardHost />
      <SessionLockGate operator={bridge.operator}>
        <AppRouter pairing={bridge.pairing} operator={bridge.operator} />
      </SessionLockGate>
    </>
  );
}
