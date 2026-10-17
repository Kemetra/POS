/**
 * RT-602 (VN-S6 S6-1b, doc 24 §2.3, §2.5, D-6-1 step A) — the active feeder's
 * single probe: one GET of Backend-Core's public liveness endpoint.
 *
 * Target (RT-600 / DEP-1): `GET {apiBaseUrl}/api/v1/health/live`. Backend-Core
 * marks it `@Public`, does not throttle it, and answers `{"status":"ok"}` with
 * `Cache-Control: no-store`, on the same app and origin as `/api/pos/v1/*`.
 * Alive means HTTP 200 with `status === "ok"`. That proves Backend-Core is
 * REACHABLE; it says nothing about whether this terminal can sync.
 *
 * The path is a named constant, not a generated type: the pinned
 * `api-types.ts` snapshot is the legacy Data-Pulse-2 document (its `/health/live`
 * is a different app), and the vendored Backend-Core contracts
 * (`contracts/backend-core`, RT-217) publish no health contract to pin against.
 *
 * The request carries NO credential (no `Authorization`, no device token, no
 * cookie), follows no redirect, and its URL, host and body are never logged.
 * The outcome is reported in the monitor's observation vocabulary:
 *  - alive                                       → `{ answer, 200 }` (reachable);
 *  - 5xx / 429                                   → that answer (degraded);
 *  - any other answer, or a 200 without the
 *    liveness body (an edge, proxy or portal)    → `not_backend_core` (degraded);
 *  - a network error, or no answer in time       → `transport_fault` (offline);
 *  - headers in time but the body too slow       → `not_backend_core` (degraded);
 *  - aborted from outside (resume, stop on quit) → `null`, no evidence.
 */
import type { ReachabilityObservation } from './terminal-status-monitor.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The Backend-Core liveness path (RT-600). Never a business route (D-6-1 C rejected). */
export const LIVENESS_PATH = '/api/v1/health/live';

export interface LivenessProbeTiming {
  /** `P`: probe interval while the passive feeder is idle. */
  readonly intervalMs: number;
  /** One probe's budget; the 15 s client timeouts are too slow to drive a flip. */
  readonly timeoutMs: number;
  /** Delay of the confirmation probe after a first bad result (K = 2). */
  readonly confirmDelayMs: number;
}

/** The approved §2.5 values (D-6-3); tuned after bench run B1 (S6-V). */
export const LIVENESS_PROBE_DEFAULTS: LivenessProbeTiming = {
  intervalMs: 10_000,
  timeoutMs: 4_000,
  confirmDelayMs: 3_000,
};

interface TimerHandle {
  unref?: () => unknown;
}

export interface RunLivenessProbeDeps {
  fetch: FetchLike;
  baseUrl: string;
  timeoutMs: number;
  /** Aborts the probe from outside (resume, stop on quit); the result is then `null`. */
  signal?: AbortSignal;
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}

const ALIVE: ReachabilityObservation = { kind: 'answer', status: 200 };
const FAULT: ReachabilityObservation = { kind: 'transport_fault' };
const NOT_BACKEND_CORE: ReachabilityObservation = { kind: 'not_backend_core' };

/** Join the path onto the configured base, keeping any base path prefix. */
export function livenessUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${LIVENESS_PATH}`;
}

const REQUEST_INIT: RequestInit = {
  method: 'GET',
  headers: { accept: 'application/json' },
  cache: 'no-store',
  credentials: 'omit',
  redirect: 'manual',
};

export async function runLivenessProbe(
  deps: RunLivenessProbeDeps,
): Promise<ReachabilityObservation | null> {
  if (wasAborted(deps.signal)) return null;
  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort();
  };
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    deps.clearTimeout ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const timer = schedule(() => {
    controller.abort();
  }, deps.timeoutMs);
  timer.unref?.();
  try {
    const result = await probeOnce(deps.fetch, livenessUrl(deps.baseUrl), controller.signal);
    return wasAborted(deps.signal) ? null : result;
  } finally {
    cancel(timer);
    deps.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function probeOnce(
  fetchImpl: FetchLike,
  url: string,
  signal: AbortSignal,
): Promise<ReachabilityObservation> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...REQUEST_INIT, signal });
  } catch {
    return FAULT;
  }
  if (response.status !== 200) {
    discardBody(response);
    return isServerFailure(response.status)
      ? { kind: 'answer', status: response.status }
      : NOT_BACKEND_CORE;
  }
  const text = await readText(response, signal);
  return text !== null && isLivenessBody(text) ? ALIVE : NOT_BACKEND_CORE;
}

function isServerFailure(status: number): boolean {
  return Math.floor(status / 100) === 5 || status === 429;
}

function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** The body text, or `null` if it failed or the probe was aborted first. */
function readText(response: Response, signal: AbortSignal): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const onAbort = (): void => {
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    response.text().then((text) => {
      signal.removeEventListener('abort', onAbort);
      resolve(text);
    }, onAbort);
  });
}

function isLivenessBody(text: string): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { status?: unknown }).status === 'ok'
  );
}
