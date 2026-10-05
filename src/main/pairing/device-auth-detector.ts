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
 * each device-bearer client is built with is wrapped by
 * {@link withDeviceAuthObservation}, tagged with that client's route family
 * and base URL (review F5). The sign-in, takeover, keeper
 * (heartbeat), roster and read-down paths therefore all go through it. The
 * confirmation call itself uses an UNOBSERVED client, and its outcome is fed
 * back here directly.
 *
 * Review F4 / RT-113 10871 OD5 (+ rev546b F-A): EVERY observed device 401
 * fires `onUnauthorized`, where the offline grants are invalidated through the
 * grant seam; the confirmation drives the session + pairing revocation.
 *
 * Logs carry the route family and the transition only — never a URL, a token
 * or a body.
 */

/** Review F3 / RT-215 decision 1: the confirmation call follows the first 401 by at most 30 s. */
export const DEVICE_401_CONFIRM_MS = 30_000;
/**
 * RT-215 review F7: ... and by at least 5 s, so a very short admission TTL
 * cannot turn the debounce into two near-simultaneous calls.
 */
export const DEVICE_401_MIN_CONFIRM_MS = 5_000;

/**
 * The device-bearer route of each family (decision 2). The paths are the
 * clients' own constants, so the detector cannot drift from them.
 */
const DEVICE_BEARER_ROUTE: Readonly<Record<DeviceRevokedSource, string>> = {
  // posCreateCashierAdmission, posEndCashierAdmission, posListCashierAdmissionRoster
  cashier_admissions: ADMISSIONS_PATH,
  // the 010 catalogue read-down (AD-7: `Authorization: Bearer <device_token>`)
  read_down: SNAPSHOT_PATH,
};

/** `ok` = a 2xx; `unauthorized` = a 401; `other` = any other answer or none. */
export type DeviceAuthOutcome = 'ok' | 'unauthorized' | 'other';

/** The detector's state: `suspect` = one 401 seen, confirmation pending. */
export type DeviceAuthState = 'clear' | 'suspect' | 'confirmed';

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Review F5 — does `url` hit the `source` route of a client whose base URL is
 * `baseUrl`? Matched relative to THAT client's base (origin + any path prefix,
 * e.g. a prefixed `VITE_API_BASE_URL`), on the route itself or a sub-path
 * (`…/roster`, `…/{id}/end`), never a look-alike prefix.
 */
export function isDeviceBearerRoute(
  url: string,
  baseUrl: string,
  source: DeviceRevokedSource,
): boolean {
  const target = parseUrl(url);
  const route = parseUrl(`${baseUrl.replace(/\/$/, '')}${DEVICE_BEARER_ROUTE[source]}`);
  if (target === null || route === null) return false;
  return isWithinRoute(target, route);
}

/** Same origin, and the route's own path or one of its sub-paths. */
function isWithinRoute(target: URL, route: URL): boolean {
  return target.origin === route.origin && isSameOrSubPath(target.pathname, route.pathname);
}

/** `path` is `routePath` itself or below it — never a look-alike prefix. */
function isSameOrSubPath(path: string, routePath: string): boolean {
  return path === routePath || path.startsWith(`${routePath}/`);
}

function outcomeForStatus(status: number): DeviceAuthOutcome {
  if (status >= 200 && status < 300) return 'ok';
  return status === 401 ? 'unauthorized' : 'other';
}

/**
 * max(5 s, min(30 s, TTL/2)): the confirmation lands well inside a short
 * admission's TTL (Codex P2 4179701427), but never so soon that one transient
 * blip is confirmed by the next call (review F7). Without a usable TTL, 30 s.
 */
export function deviceAuthConfirmDelayMs(ttlSeconds: number | undefined): number {
  if (!isUsableTtl(ttlSeconds)) return DEVICE_401_CONFIRM_MS;
  const halfTtl = Math.floor((ttlSeconds * 1000) / 2);
  return Math.max(DEVICE_401_MIN_CONFIRM_MS, Math.min(DEVICE_401_CONFIRM_MS, halfTtl));
}

/** A TTL that can bound the confirmation: a finite, positive number of seconds. */
function isUsableTtl(ttlSeconds: number | undefined): ttlSeconds is number {
  return ttlSeconds !== undefined && Number.isFinite(ttlSeconds) && ttlSeconds > 0;
}

export interface DeviceAuthDetectorDeps {
  /** The confirmation call (the roster, on an unobserved client). Never sends a revoked token. */
  probe: () => Promise<DeviceAuthOutcome>;
  /** Delay before the confirmation call, read at the first 401 (min(30 s, TTL/2)). */
  confirmDelayMs: () => number;
  /** Revocation confirmed; `source` is the route family of the FIRST 401. Called once. */
  onConfirmed: (source: DeviceRevokedSource) => void;
  /**
   * Review F4 / RT-113 10871 OD5 + rev546b F-A — EVERY observed device 401
   * (from any source, the first of a count and every later one) while the
   * detector is neither stopped nor confirmed: offline grants are invalidated
   * here, before any confirmation. An admission minted after the first 401
   * can still be answered `admitted`; only a later invalidation drops it (the
   * #545 send mark). Optional; a throw is contained.
   */
  onUnauthorized?: (source: DeviceRevokedSource) => void;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface DeviceAuthDetector {
  /** One answer from a device-bearer route of `source` (the observed fetch filters routes). */
  observe(source: DeviceRevokedSource, status: number): void;
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
      observeOutcome('cashier_admissions', outcome);
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

  /** rev546b F-A: EVERY observed device 401 reaches the hook (contained). */
  function reportUnauthorized(source: DeviceRevokedSource): void {
    try {
      deps.onUnauthorized?.(source);
    } catch {
      // The grant seam logs its own failures; the confirmation still runs.
    }
  }

  function observeOutcome(source: DeviceRevokedSource, outcome: DeviceAuthOutcome): void {
    if (stopped || state === 'confirmed') return;
    if (outcome === 'ok') {
      toClear();
      return;
    }
    if (outcome !== 'unauthorized') return;
    reportUnauthorized(source);
    if (state === 'suspect') return; // the confirmation is already pending
    state = 'suspect';
    firstSource = source;
    deps.logger?.info(
      { event: 'pairing.device_auth.suspect', source },
      'device credential refused once; confirming',
    );
    scheduleConfirmation();
  }

  return {
    observe(source, status) {
      observeOutcome(source, outcomeForStatus(status));
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

/** Review F5 — which client an observed fetch belongs to. */
export interface DeviceAuthObservationTag {
  /** The client's route family. */
  source: DeviceRevokedSource;
  /** The client's own base URL; routes are matched relative to it. */
  baseUrl: string;
}

/**
 * The fetch for ONE device-bearer client, tagged with its route family and
 * base URL (review F5): an answer on that client's device-bearer route is
 * reported to the detector; any other URL is ignored. The response is
 * returned untouched; a transport failure is rethrown unreported (it is not
 * an answer). A failing observer never breaks the call.
 */
export function withDeviceAuthObservation(
  fetchImpl: FetchLike,
  detector: Pick<DeviceAuthDetector, 'observe'>,
  tag: DeviceAuthObservationTag,
): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    try {
      if (isDeviceBearerRoute(urlOf(input), tag.baseUrl, tag.source)) {
        detector.observe(tag.source, response.status);
      }
    } catch {
      // Observation is best-effort.
    }
    return response;
  };
}
