import type { Logger } from 'pino';

import type { DeviceRevokedSource } from '../../shared/pairing-types.js';
import { SNAPSHOT_PATH } from '../catalogue/read-down/read-down-client.js';
import { ADMISSIONS_PATH } from '../operator/cashier-admission-client.js';

/**
 * RT-215 (RT-138 P-1) — the ONE device-401 detector.
 *
 * Backend-Core answers 401 on a device-bearer route when it refuses this
 * terminal's device credential (RT-113 10763 D8). A single 401 can be
 * transient (a misconfigured proxy, a gateway blip), so it must not destroy
 * the pairing. Coordinator decisions (RT-215 comment 10873, confirmed by the
 * owner in 10875):
 *
 *  1. Revocation is confirmed by TWO consecutive device-bearer 401s. The
 *     second comes from a confirmation call — the cashier-admissions roster
 *     (`GET /api/pos/v1/cashier-admissions/roster`) — made min(30 s, TTL/2)
 *     after the first. Any device-bearer 2xx in between resets the count.
 *     Other device-bearer 401s while the confirmation is pending (a sign-in,
 *     a takeover, a heartbeat, a read-down) neither confirm early nor restart
 *     the wait.
 *  2. Only device-bearer routes count: the three cashier-admissions routes
 *     and the catalogue read-down. Operator-credential 401s (sale sync,
 *     returns, vouchers) are ignored — they mean the operator's envelope or
 *     JWT was refused, not the device.
 *
 * Every device-bearer call reaches this detector through ONE seam: the fetch
 * the device-bearer clients are built with is wrapped by
 * {@link withDeviceAuthObservation}. The sign-in, takeover, keeper
 * (heartbeat), roster and read-down paths therefore all go through it. The
 * confirmation call itself uses an UNOBSERVED client, and its outcome is fed
 * back here directly.
 *
 * This detector covers the session + pairing revocation only. Invalidating
 * offline grants on the FIRST 401 is RT113-P1.2's grant seam (10871 OD5) and
 * is not done here.
 *
 * Logs carry the route family and the transition only — never a URL, a token
 * or a body.
 */

/** Review F3 / RT-215 decision 1: the confirmation call follows the first 401 by at most 30 s. */
export const DEVICE_401_CONFIRM_MS = 30_000;

/**
 * The device-bearer route families (decision 2), matched on the URL path. The
 * paths are the clients' own constants, so the detector cannot drift from them.
 */
const DEVICE_BEARER_ROUTES: readonly { source: DeviceRevokedSource; path: string }[] = [
  // posCreateCashierAdmission, posEndCashierAdmission, posListCashierAdmissionRoster
  { source: 'cashier_admissions', path: ADMISSIONS_PATH },
  // the 010 catalogue read-down (AD-7: `Authorization: Bearer <device_token>`)
  { source: 'read_down', path: SNAPSHOT_PATH },
];

/** `ok` = a 2xx; `unauthorized` = a 401; `other` = any other answer or none. */
export type DeviceAuthOutcome = 'ok' | 'unauthorized' | 'other';

/** The detector's state: `suspect` = one 401 seen, confirmation pending. */
export type DeviceAuthState = 'clear' | 'suspect' | 'confirmed';

function pathnameOf(url: string): string | null {
  try {
    return new URL(url, 'http://relative.invalid').pathname;
  } catch {
    return null;
  }
}

/**
 * The device-bearer route family of `url`, or null for any other route. A
 * route matches its own path or a sub-path (`…/roster`, `…/{id}/end`), never a
 * look-alike prefix.
 */
export function deviceBearerSource(url: string): DeviceRevokedSource | null {
  const pathname = pathnameOf(url);
  if (pathname === null) return null;
  const route = DEVICE_BEARER_ROUTES.find(
    (r) => pathname === r.path || pathname.startsWith(`${r.path}/`),
  );
  return route?.source ?? null;
}

function outcomeForStatus(status: number): DeviceAuthOutcome {
  if (status >= 200 && status < 300) return 'ok';
  return status === 401 ? 'unauthorized' : 'other';
}

/**
 * min(30 s, TTL/2): the confirmation lands well inside a short admission's
 * TTL (Codex P2 4179701427). Without a usable TTL, 30 s.
 */
export function deviceAuthConfirmDelayMs(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEVICE_401_CONFIRM_MS;
  }
  return Math.min(DEVICE_401_CONFIRM_MS, Math.floor((ttlSeconds * 1000) / 2));
}

export interface DeviceAuthDetectorDeps {
  /** The confirmation call (the roster, on an unobserved client). Never sends a revoked token. */
  probe: () => Promise<DeviceAuthOutcome>;
  /** Delay before the confirmation call, read at the first 401 (min(30 s, TTL/2)). */
  confirmDelayMs: () => number;
  /** Revocation confirmed; `source` is the route family of the FIRST 401. Called once. */
  onConfirmed: (source: DeviceRevokedSource) => void;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface DeviceAuthDetector {
  /** One device-bearer answer: an HTTP status for `url`. Non-device-bearer URLs are ignored. */
  observeResponse(url: string, status: number): void;
  readonly state: DeviceAuthState;
  /** Back to `clear` (a successful re-pair). */
  reset(): void;
  /** Shutdown latch: cancels the pending confirmation; nothing runs afterwards. */
  stop(): void;
}

export function createDeviceAuthDetector(deps: DeviceAuthDetectorDeps): DeviceAuthDetector {
  let state: DeviceAuthState = 'clear';
  let stopped = false;
  /** Source of the FIRST 401 of the current count. */
  let firstSource: DeviceRevokedSource = 'cashier_admissions';
  /** Bumped on every reset, so a confirmation that settles late is recognised. */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function toClear(): void {
    cancelTimer();
    generation += 1;
    if (state === 'suspect') {
      deps.logger?.info(
        { event: 'pairing.device_auth.cleared', source: firstSource },
        'device credential accepted again; revocation not confirmed',
      );
    }
    state = 'clear';
  }

  function scheduleConfirmation(): void {
    cancelTimer();
    const gen = generation;
    timer = setTimeout(() => {
      timer = null;
      void confirm(gen);
    }, deps.confirmDelayMs());
  }

  async function confirm(gen: number): Promise<void> {
    let outcome: DeviceAuthOutcome;
    try {
      outcome = await deps.probe();
    } catch {
      outcome = 'other';
    }
    if (stopped) return;
    if (gen !== generation || state !== 'suspect') {
      // The count was reset while the call was in flight: its answer is just
      // another device-bearer answer (the roster is a cashier-admissions route).
      observe('cashier_admissions', outcome);
      return;
    }
    if (outcome === 'unauthorized') {
      state = 'confirmed';
      deps.logger?.warn(
        { event: 'pairing.device_auth.confirmed', source: firstSource },
        'device credential refused twice; device revoked',
      );
      try {
        deps.onConfirmed(firstSource);
      } catch {
        // The revocation handler logs its own failures; the state stays confirmed.
      }
      return;
    }
    if (outcome === 'ok') {
      toClear();
      return;
    }
    scheduleConfirmation(); // no answer: keep the count, confirm again later
  }

  function observe(source: DeviceRevokedSource, outcome: DeviceAuthOutcome): void {
    if (stopped || state === 'confirmed') return;
    if (outcome === 'ok') {
      toClear();
      return;
    }
    if (outcome !== 'unauthorized' || state === 'suspect') return;
    state = 'suspect';
    firstSource = source;
    deps.logger?.info(
      { event: 'pairing.device_auth.suspect', source },
      'device credential refused once; confirming',
    );
    scheduleConfirmation();
  }

  return {
    observeResponse(url, status) {
      const source = deviceBearerSource(url);
      if (source === null) return;
      observe(source, outcomeForStatus(status));
    },
    get state() {
      return state;
    },
    reset() {
      if (stopped) return;
      toClear();
    },
    stop() {
      stopped = true;
      cancelTimer();
    },
  };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * The fetch for the device-bearer clients: every answer is reported to the
 * detector (which ignores non-device-bearer routes). The response is returned
 * untouched; a transport failure is rethrown unreported (it is not an
 * answer). A failing observer never breaks the call.
 */
export function withDeviceAuthObservation(
  fetchImpl: FetchLike,
  detector: Pick<DeviceAuthDetector, 'observeResponse'>,
): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    try {
      detector.observeResponse(urlOf(input), response.status);
    } catch {
      // Observation is best-effort.
    }
    return response;
  };
}
