import type { components } from '../../shared/api-types.js';

/**
 * 002-terminal-pairing T021 + T039 + T053 — `network.pair()`.
 *
 * T039 (US3): no behaviour change. The contract below was already
 * "resolve verbatim on every reachable response, including non-2xx";
 * T038 added regression tests for the three documented US3 failure
 * envelopes (400 INVALID_CODE / 410 EXPIRED_CODE / 409 ALREADY_PAIRED),
 * each of which surfaces unchanged through the existing implementation.
 *
 * T053 (US5): adds `Retry-After` header parsing on `status === 429`.
 * The parsed-and-clamped value is attached to the resolved failure
 * envelope as `retry_after_s`. The header value is consulted ONLY on
 * 429 — non-429 responses (even those carrying a Retry-After header)
 * leave the field undefined, because the renderer's disabled-timer
 * surface is bound to the RATE_LIMITED outcome, not the header. The
 * resolve-on-reachable / reject-only-on-transport contract above is
 * unchanged.
 *
 * The only `fetch` site in the pairing slice. Contract (LOCKED from MVP
 * onward — every later US refines body-code mapping but never changes
 * this contract):
 *
 *   - Resolve on every reachable backend response, including non-2xx.
 *     Non-2xx becomes `{ ok: false, status, body }`. Even a malformed
 *     non-JSON body becomes `{ ok: false, status, body: {} }` rather
 *     than throwing.
 *   - Reject ONLY on transport failure: DNS / TLS / connection refused,
 *     `fetch` rejection, or `AbortSignal` abort. Rejection is a typed
 *     `TransportError`. The error message MUST contain neither the
 *     submitted `pairing_code` nor any token-shaped string.
 *   - 30 s client-side timeout via `AbortSignal.timeout(30_000)`. The
 *     resulting rejection is a `TransportError` with `timed_out: true`.
 *
 * Why this contract: it lets the service treat backend and network
 * outcomes uniformly (`submit() never rejects for either`) and pushes
 * the *category* decision into a single place. US3/US4/US5 then refine
 * the typed body-code mapping in `failure-mapping.ts` without ever
 * changing this module's surface.
 *
 * Security policy (Constitution VII + spec NFR-4 / FR-9 / FR-10):
 *   - The `pairing_code` is read from the argument, placed in the
 *     request body, and never retained in any module-level closure or
 *     emitted to a logger.
 *   - The wrapped error path strips the inner error's message
 *     unconditionally — even if the runtime/library accidentally
 *     surfaces the request body in the error, the wrapper's message is
 *     a stable, secret-free string.
 *   - The `Retry-After` header value is parsed locally and never
 *     emitted to a logger; the parsed integer that flows downstream is
 *     a public timer value, not a secret.
 */

const PAIR_PATH = '/api/pos/v1/terminals/pair';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Retry-After parsing bounds (T053).
 *
 *   MIN clamp prevents a buggy backend from sending a zero/negative
 *   value that would let submit fire immediately and re-trigger the
 *   rate limit.
 *   MAX clamp prevents a malicious or buggy backend from disabling
 *   submit indefinitely (research §4 explicit rationale).
 *   DEFAULT applies on missing / malformed values; matches the spec
 *   contract at pairing-http.md:67.
 */
const RETRY_AFTER_MIN_S = 1;
const RETRY_AFTER_MAX_S = 300;
const RETRY_AFTER_DEFAULT_S = 30;

type PairRequestBody = components['schemas']['TerminalPairRequest'];
export type PairSuccessBody = components['schemas']['TerminalPairResponse'];

/**
 * Failure body shape. Backend-Core returns pairing failures in the canonical
 * envelope `{ error: { code, message, request_id? } }`
 * (`pos-terminal-pairing.openapi.yaml` `components.schemas.Error`), but
 * real-world non-2xx responses MAY have any shape (or none). We type the
 * field loosely here and let `failure-mapping.ts` read `error.code`
 * defensively. (RT-228: this was previously a flat `{ code, message }`.)
 */
export interface PairFailureBody {
  error?: unknown;
  [key: string]: unknown;
}

export type PairResult =
  | { ok: true; status: 200; body: PairSuccessBody }
  | {
      ok: false;
      status: number;
      body: PairFailureBody;
      /**
       * Parsed-and-clamped `Retry-After` value in seconds. Set ONLY
       * when `status === 429` (T053). Never present on other statuses
       * even if the backend carries a Retry-After header — the
       * renderer's disabled-timer surface is bound to the
       * RATE_LIMITED outcome, not the header.
       */
      retry_after_s?: number;
    };

/**
 * Typed transport-level error. Distinct from a backend "failure
 * envelope" — a `TransportError` means the request did not reach a
 * usable response. The `timed_out` flag is `true` only when the
 * built-in 30 s `AbortSignal.timeout` fired.
 *
 * MUST NOT carry the `pairing_code` or any token in any field, by
 * construction (the wrapper builds the message from a fixed string
 * table).
 */
export class TransportError extends Error {
  public readonly timed_out: boolean;

  public constructor(opts: { timed_out: boolean; reason: TransportErrorReason }) {
    super(transportErrorMessageFor(opts.reason));
    this.name = 'TransportError';
    this.timed_out = opts.timed_out;
  }

  /**
   * Override default JSON serialisation so JSON.stringify(err) yields
   * a stable shape WITHOUT enumerating any inner cause that could
   * carry sensitive data.
   */
  public toJSON(): { name: string; message: string; timed_out: boolean } {
    return { name: this.name, message: this.message, timed_out: this.timed_out };
  }
}

type TransportErrorReason = 'timeout' | 'fetch_failed';

function transportErrorMessageFor(reason: TransportErrorReason): string {
  // Stable, secret-free messages. Do NOT interpolate the inner error,
  // request body, or any user-supplied value.
  switch (reason) {
    case 'timeout':
      return 'pairing request timed out after 30s.';
    case 'fetch_failed':
      return 'pairing request failed at the transport layer (DNS/TLS/refused).';
  }
}

export interface NetworkDeps {
  /**
   * The `fetch` implementation. Production binds to the global `fetch`;
   * tests inject a fake. We model the signature against the standard
   * Fetch API but accept either Request or string for input.
   */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Base URL — `${baseUrl}/api/pos/v1/terminals/pair`. */
  baseUrl: string;
  /**
   * Override the timeout window in tests. Defaults to 30_000 ms per
   * the spec (T021b). The renderer test (T027) verifies the form is
   * disabled-not-frozen during this window.
   */
  timeoutMs?: number;
}

export interface Network {
  pair(pairing_code: string): Promise<PairResult>;
}

export function createNetwork(deps: NetworkDeps): Network {
  const { fetch: fetchImpl, baseUrl } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async pair(pairing_code: string): Promise<PairResult> {
      const url = `${baseUrl}${PAIR_PATH}`;
      const body: PairRequestBody = { pairing_code };
      const signal = AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        // The only paths that throw out of fetch are transport failures
        // and signal aborts. Distinguish timeout from generic failure.
        const reason = classifyTransportRejection(err, signal);
        throw new TransportError({
          timed_out: reason === 'timeout',
          reason,
        });
      }

      if (response.ok) {
        // 200 path. Parse the body defensively; even here we tolerate
        // a malformed body rather than throwing — the service can still
        // surface a generic `unknown_error` if the shape is wrong.
        const parsed = await parseJsonSafely(response);
        return {
          ok: true,
          status: 200,
          body: parsed as unknown as PairSuccessBody,
        };
      }

      // Reachable non-2xx: resolve with the typed failure shape. Any
      // body parse failure becomes an empty object so the service has
      // something to read defensively.
      //
      // T053 (US5): on status === 429, parse Retry-After and attach
      // the clamped value to the envelope. On every other status, the
      // field stays undefined — bind the disabled-timer surface to
      // the RATE_LIMITED outcome, not to header presence.
      const parsed = await parseJsonSafely(response);
      if (response.status === 429) {
        return {
          ok: false,
          status: 429,
          body: parsed,
          retry_after_s: parseRetryAfter(response.headers.get('Retry-After')),
        };
      }
      return {
        ok: false,
        status: response.status,
        body: parsed,
      };
    },
  };
}

/**
 * Parse the `Retry-After` header into a clamped integer-seconds value.
 *
 * Accepts both forms documented in RFC 7231:
 *   - `delta-seconds` (e.g., `"5"`)
 *   - `HTTP-date`     (RFC 7231 IMF-fixdate / RFC 850 / asctime —
 *                      delegated to `Date.parse()`)
 *
 * Behaviour:
 *   - Missing (`null`) / empty / malformed → returns `RETRY_AFTER_DEFAULT_S`.
 *   - Negative or past dates                → clamped to `RETRY_AFTER_MIN_S`.
 *   - Above max                             → clamped to `RETRY_AFTER_MAX_S`.
 *
 * Security: the function does not log the header value or expose it
 * via a thrown error. The returned integer is a public timer value.
 */
function parseRetryAfter(headerValue: string | null): number {
  if (headerValue === null) return RETRY_AFTER_DEFAULT_S;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return RETRY_AFTER_DEFAULT_S;

  // Integer delta-seconds first. Accept an optional leading '-' so we
  // can clamp negatives explicitly rather than treating them as
  // malformed (the spec wants negatives to clamp to MIN, not default).
  if (/^-?\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return clampRetryAfter(seconds);
  }

  // HTTP-date fallback. Date.parse returns NaN on unrecognised input.
  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs)) return RETRY_AFTER_DEFAULT_S;
  const deltaSeconds = Math.round((targetMs - Date.now()) / 1000);
  return clampRetryAfter(deltaSeconds);
}

function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds)) return RETRY_AFTER_DEFAULT_S;
  if (seconds < RETRY_AFTER_MIN_S) return RETRY_AFTER_MIN_S;
  if (seconds > RETRY_AFTER_MAX_S) return RETRY_AFTER_MAX_S;
  return seconds;
}

/**
 * Read the response body as JSON, returning `{}` on any parse failure
 * or non-JSON content. NEVER throws — the network contract requires
 * "resolve on every reachable response" so a malformed body cannot
 * be a rejection reason.
 */
async function parseJsonSafely(response: Response): Promise<Record<string, unknown>> {
  try {
    const text = await response.text();
    if (text.length === 0) return {};
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Decide which TransportErrorReason fits a given fetch rejection.
 * Two branches:
 *
 *   - 'timeout'      — the AbortSignal.timeout fired (signal.aborted set).
 *   - 'fetch_failed' — anything else (network down, DNS, TLS, refused).
 *
 * We deliberately do NOT inspect the inner error's message text — that
 * would risk surfacing user-supplied values that the runtime placed
 * into the message.
 */
function classifyTransportRejection(err: unknown, signal: AbortSignal): TransportErrorReason {
  // AbortSignal.timeout is the only abort source we use in this module,
  // so any aborted signal at this point is a timeout. If a future
  // caller wires an external signal, this classifier should split a
  // separate 'aborted' branch.
  void err; // intentionally unused — see security comment above
  return signal.aborted ? 'timeout' : 'fetch_failed';
}
