/**
 * RT-601 (VN-S6 S6-1a, doc 24 §2.3, §2.4, D-6-1 step B) — the passive feeder:
 * a transport-level observation seam on the Backend-Core fetch paths.
 *
 * `withReachabilityObservation` wraps a fetch and reports what the transport
 * did — an HTTP status, or a rejection (`transport_fault`: DNS, TLS, refused,
 * timeout). Unlike RT-215's `observedFetch` it reports the rejection too, then
 * rethrows the SAME error. It only observes: the request arguments are passed
 * through as given, the response object is returned untouched (its body is
 * never read), and a failing observer never breaks the call.
 *
 * It classifies at the transport level, never from a client's result union:
 * that union's `no_connection` also means "no token held" or "the terminal
 * changed", and those cases make no request, so they never reach the seam.
 *
 * The observation carries a status or a fault kind only — never a URL, host,
 * header or error message.
 */
import type { ReachabilityObservation } from './terminal-status-monitor.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ObservationClass = 'reachable' | 'server_failure' | 'transport_fault' | 'ignored';

/**
 * 4xx statuses that Backend-Core itself answers with an error body (§2.4). A
 * 401 proves reachability; device revocation stays the RT-215 detector's job.
 * The seam does not read bodies, so it trusts the status; any other 4xx is not
 * evidence either way.
 */
const BACKEND_CORE_4XX: ReadonlySet<number> = new Set([401, 403, 404, 409, 422]);

/**
 * Status → evidence (§2.2, §2.4):
 *  - 2xx and the Backend-Core 4xx set → `reachable`;
 *  - 5xx (incl. an edge's 502/503/504/521) and 429 → `server_failure` (degraded);
 *  - anything else (1xx, 3xx, other 4xx) → `ignored`.
 */
export function classifyObservation(observation: ReachabilityObservation): ObservationClass {
  if (observation.kind === 'transport_fault') return 'transport_fault';
  const { status } = observation;
  const statusClass = Math.floor(status / 100);
  if (statusClass === 2) return 'reachable';
  if (BACKEND_CORE_4XX.has(status)) return 'reachable';
  if (statusClass === 5) return 'server_failure';
  if (status === 429) return 'server_failure';
  return 'ignored';
}

export function withReachabilityObservation(
  fetchImpl: FetchLike,
  observe: (observation: ReachabilityObservation) => void,
): FetchLike {
  const report = (observation: ReachabilityObservation): void => {
    try {
      observe(observation);
    } catch {
      // Observation is best-effort.
    }
  };
  return async (input, init) => {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (err) {
      report({ kind: 'transport_fault' });
      throw err;
    }
    report({ kind: 'answer', status: response.status });
    return response;
  };
}
