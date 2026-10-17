import { randomUUID } from 'node:crypto';

/**
 * RT-634 (OBS-5) — `X-Request-Id` on every Backend-Core call (OBS-1 contract
 * §2: the caller mints one lowercase hyphenated UUID v4/v7 per HTTP call;
 * Backend-Core's `RequestIdInterceptor` keeps a well-formed value, logs it as
 * `request_id` and echoes it).
 *
 * One wrapper around the BASE fetch in `index.ts` covers every Backend-Core
 * client (operator, cashier admissions, pairing, read-down, sale sync, void,
 * returns, sale history, shift sync, vouchers, liveness probe). Clerk is not
 * Backend-Core and is not wrapped.
 *
 * The id is logged locally with the method, the PATH (never the query string)
 * and the status, so a POS log line joins a Backend-Core log line. Retries
 * mint a new id: each HTTP call is its own request. Observation is
 * best-effort: a failing logger never breaks or delays the call.
 */

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const REQUEST_ID_HEADER = 'X-Request-Id';

export interface RequestIdLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  debug(fields: Record<string, unknown>, msg: string): void;
}

export interface WithRequestIdOptions {
  logger: RequestIdLogger;
  /** Log at `debug` instead of `info` (the idle liveness probe, every 10 s). */
  quiet?: boolean;
  /** Clock for `duration_ms`; tests inject a fake. */
  now?: () => number;
  /** Id minter; `crypto.randomUUID` (UUID v4, lowercase) in production. */
  mintId?: () => string;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '[unparsable]';
  }
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

/** A copy of the call's headers (init wins over a Request's own) plus the id. */
function headersWithId(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  requestId: string,
): Headers {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(source);
  headers.set(REQUEST_ID_HEADER, requestId);
  return headers;
}

export function withRequestId(fetchImpl: FetchLike, opts: WithRequestIdOptions): FetchLike {
  const now = opts.now ?? (() => Date.now());
  const mintId = opts.mintId ?? randomUUID;
  const write = (fields: Record<string, unknown>): void => {
    try {
      if (opts.quiet === true) opts.logger.debug(fields, 'backend:request');
      else opts.logger.info(fields, 'backend:request');
    } catch {
      // Observation is best-effort.
    }
  };

  return async (input, init) => {
    const requestId = mintId();
    const base = {
      request_id: requestId,
      method: methodOf(input, init),
      path: pathOf(requestUrl(input)),
    };
    const started = now();
    let response: Response;
    try {
      response = await fetchImpl(input, {
        ...init,
        headers: headersWithId(input, init, requestId),
      });
    } catch (err) {
      write({ ...base, outcome: 'transport_error', duration_ms: now() - started });
      throw err;
    }
    write({ ...base, status: response.status, duration_ms: now() - started });
    return response;
  };
}
