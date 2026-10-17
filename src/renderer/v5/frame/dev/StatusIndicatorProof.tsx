import type { JSX } from 'react';
import type { TerminalStatusBridgeAPI } from '../../../../shared/bridge-api';
import type {
  ConnectionStateCode,
  TerminalStatusSnapshot,
  TerminalStatusSync,
} from '../../../../shared/terminal-status/types';
import { OneFrameProof, readOneFrameProofParams } from './OneFrameProof';

/**
 * RT-604 (VN-S6 S6-3) — DEV-ONLY status indicator harness
 * (`#/dev/status-proof?state=<State>&path=<route>`), the same contract as the
 * RT-445 / RT-498 harnesses: the REAL AppRouter and V5 frame, with the real
 * StatusIndicator fed through an in-memory `window.api.terminalStatus` that
 * answers one fixed snapshot. Nothing writes the status store directly; the
 * indicator reads it through the same bridge subscription as production.
 * It proves layout and presentation only; the packaged bench is S6-V.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds. Every other query key is OneFrameProof's (`path`,
 * `role`, …); `state=PrinterFailed` also sets `banner=printer`.
 */

export const STATUS_PROOF_STATES = [
  'Connected',
  'Checking',
  'Offline',
  'Degraded',
  'OfflinePending',
  'Sending',
  'Paused',
  'Attention',
  'PrinterFailed',
] as const;
export type StatusProofState = (typeof STATUS_PROOF_STATES)[number];

const HOUR = 60 * 60 * 1000;

function snapshot(
  connection: ConnectionStateCode,
  sync: Partial<TerminalStatusSync> = {},
): TerminalStatusSnapshot {
  const now = Date.now();
  return {
    v: 1,
    connection,
    connectionSince: new Date(now - 2 * 60 * 1000).toISOString(),
    lastContactAt: connection === 'online' ? new Date(now - 5000).toISOString() : null,
    sync: {
      pending: 0,
      heldPreviousPairing: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      paused: null,
      lastSuccessAt: new Date(now - HOUR).toISOString(),
      ...sync,
    },
  };
}

function pending(n: number): Partial<TerminalStatusSync> {
  return { pending: n, oldestPendingAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
}

function snapshotFor(state: StatusProofState): TerminalStatusSnapshot {
  switch (state) {
    case 'Checking':
      return snapshot('checking');
    case 'Offline':
      return snapshot('offline');
    case 'Degraded':
      return snapshot('degraded');
    case 'OfflinePending':
      return snapshot('offline', pending(3));
    case 'Sending':
      return snapshot('online', pending(3));
    case 'Paused':
      return snapshot('online', { ...pending(2), paused: 'no_operator_credential' });
    case 'Attention':
      return snapshot('online', { ...pending(1), deadLetter: 2 });
    default:
      return snapshot('online');
  }
}

export function readStatusProofState(): StatusProofState {
  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('state');
  return STATUS_PROOF_STATES.find((s) => s === raw) ?? 'Connected';
}

function statusBridge(state: StatusProofState): TerminalStatusBridgeAPI {
  const answer = snapshotFor(state);
  return {
    get: () => Promise.resolve(answer),
    onChanged: () => () => undefined,
  };
}

export function StatusIndicatorProof(): JSX.Element {
  const state = readStatusProofState();
  const params = readOneFrameProofParams();
  return (
    <OneFrameProof
      params={state === 'PrinterFailed' ? { ...params, banner: 'printer' } : params}
      extraApi={{ terminalStatus: statusBridge(state) }}
    />
  );
}
