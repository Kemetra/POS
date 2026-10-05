import type { Logger } from 'pino';

import type { BackendClient } from './backend-client.js';

/**
 * RT-215 / Codex P1 4181556645 — a sign-in or takeover must not complete under
 * a pairing other than the one it started under.
 *
 * A manager sign-in, a cashier sign-in or a takeover awaits the network before
 * it creates the local session. If the device revocation is confirmed (or the
 * terminal is re-paired) during that await, a late success must be dropped:
 * otherwise `SessionManager.create()` would install an UNLATCHED session — and
 * repopulate the credential holders — under a revoked pairing, which after a
 * re-pair could regain `/app` under the old operator/store scope.
 *
 * The handlers capture the pairing epoch (`PairingStore.getPairingEpoch()`:
 * null while revoked or unpaired, a new value on every pairing) when the
 * request starts, and check it SYNCHRONOUSLY right before `create()` — no await
 * between the check, `create()` and the holder writes, so a revocation cannot
 * interleave.
 */

/** `PairingStore.getPairingEpoch` — null while revoked or unpaired. */
export type PairingEpochReader = () => string | null;

export interface PairingEpochTicket {
  /** Undefined when the handler is not wired with a reader (tests only). */
  readonly read: PairingEpochReader | undefined;
  readonly epoch: string | null;
}

function safeRead(read: PairingEpochReader): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** Capture the epoch at request start (or reuse one recorded earlier). */
export function capturePairingEpoch(
  read: PairingEpochReader | undefined,
  recorded?: string | null,
): PairingEpochTicket {
  if (read === undefined) return { read, epoch: null };
  return { read, epoch: recorded !== undefined ? recorded : safeRead(read) };
}

/**
 * True when the pairing the request started under is still the current,
 * unrevoked one. Without a reader (tests that predate RT-215) it holds.
 */
export function pairingEpochHolds(ticket: PairingEpochTicket): boolean {
  if (ticket.read === undefined) return true;
  return ticket.epoch !== null && safeRead(ticket.read) === ticket.epoch;
}

/** The epoch to record on a takeover proto, when wired. */
export function epochToRecord(ticket: PairingEpochTicket): { pairing_epoch?: string | null } {
  return ticket.read === undefined ? {} : { pairing_epoch: ticket.epoch };
}

/**
 * Codex P2 4186872826 — when the epoch refusal drops a late manager/admin
 * success (sign-in or takeover confirm), the backend already created an
 * operator session for it. Release it with the existing best-effort
 * `POST /operators/sign-out` rather than abandoning it.
 *
 * That route is the `operator-identity` scheme only: the provider JWT in
 * `Authorization` and `{ session_id }` in the body (`createBackendClient`
 * over the plain global fetch). The device bearer is NEVER involved, so this
 * stays safe after a revocation. Fire-and-forget: the refusal is not delayed,
 * and every failure (rejection or synchronous throw) is contained. Nothing
 * about the credential or the session id is logged.
 */
export function signOutAbandonedSession(
  backend: Pick<BackendClient, 'signOut'>,
  abandoned: { readonly session_id: string; readonly jwt: string | null | undefined },
  logger?: Logger,
): void {
  const jwt = abandoned.jwt ?? '';
  if (jwt === '') return;
  const log = (outcome: string): void => {
    logger?.info(
      { event: 'operator.pairing_changed.abandoned_session_sign_out', outcome },
      'abandoned backend session sign-out',
    );
  };
  let sent: Promise<unknown>;
  try {
    sent = backend.signOut({ session_id: abandoned.session_id }, jwt);
  } catch {
    log('threw');
    return;
  }
  void Promise.resolve(sent).then(
    () => {
      log('sent');
    },
    () => {
      log('failed');
    },
  );
}
