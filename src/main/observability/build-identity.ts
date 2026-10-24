import { readFileSync } from 'node:fs';

/**
 * RT-719 (RT-709 decision O-8) — the POS reports which build it is running to
 * Backend-Core, so the fleet baseline of the POS compatibility matrix (RT-713)
 * is evidence and not a manual inventory.
 *
 * The wire is Backend-Core's "Build identity report" rule
 * (`pos-terminal-pairing.openapi.yaml`, runtime `parseBuildIdentityHeaders`):
 * three OPTIONAL request headers on the device-token requests of thirteen
 * reporting operations and nowhere else.
 *
 *   X-POS-Build-Commit   the POS git commit, 40 lower-case hex: the identity anchor
 *   X-POS-Contract-Pin   the Backend-Core commit in `contracts/backend-core/PIN`, 40 lower-case hex
 *   X-POS-App-Version    NOT SENT: the contract says to send it only for a release
 *                        version, and POS has no signed release yet (`package.json`
 *                        0.1.0 is a placeholder, not a release). When POS releases,
 *                        add it here, from `app.getVersion()`.
 *
 * Rules this module keeps:
 *   - Unknown is never a default. A value the build does not have (no stamp, an
 *     invalid value) is a header that is not sent. A terminal that sends no
 *     valid commit reads as "unknown" at Backend-Core; it is never given one.
 *   - A header never fails, slows or changes a request: every lookup here is
 *     best-effort, and on any doubt the request goes out exactly as it was.
 *   - Only the terminal's own device token reports. Several reporting routes are
 *     shared with an operator credential (sale history, sale capture), and the
 *     contract puts the headers on the device-token request only, so the wrapper
 *     compares the request's bearer with the terminal's current device token.
 *   - The values carry no PII, secret or path: a git commit and a git commit.
 */

export interface BuildIdentity {
  /** 40 lower-case hex. */
  readonly commit: string;
  /** 40 lower-case hex, or null when the build has no valid pin. */
  readonly contractPin: string | null;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const COMMIT_HEADER = 'X-POS-Build-Commit';
export const CONTRACT_PIN_HEADER = 'X-POS-Contract-Pin';
/** Every header this module can send (the app version is deliberately absent). */
export const BUILD_IDENTITY_HEADERS = [COMMIT_HEADER, CONTRACT_PIN_HEADER] as const;

const GIT_COMMIT = /^[0-9a-f]{40}$/;

function validCommit(value: unknown): string | null {
  return typeof value === 'string' && GIT_COMMIT.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The identity a build stamp (`dist/build-identity.json`, written by
 * `scripts/stamp-build-identity.ts`) carries, or null (unknown) without a valid
 * commit. An invalid pin is dropped, never repaired. Any other field is ignored.
 */
export function parseBuildIdentity(text: string): BuildIdentity | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const fields = raw;
  const commit = validCommit(fields['commit']);
  if (commit === null) return null;
  return { commit, contractPin: validCommit(fields['contractPin']) };
}

/** Reads and parses the build stamp; a missing or unreadable file is unknown (null). */
export function loadBuildIdentity(
  file: string,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): BuildIdentity | null {
  try {
    return parseBuildIdentity(read(file));
  } catch {
    return null;
  }
}

interface ReportingRoute {
  readonly method: string;
  readonly path: RegExp;
}

/**
 * The thirteen reporting operations of the contract, by the verb and route the
 * POS calls (paths relative to the Backend-Core base URL). An operation outside
 * this set (the rotation, the heartbeat, forced close, the operator routes, the
 * other sale routes) carries no header even though it may carry the rotate-soon
 * hint: the hint does not make an operation a reporting one.
 */
const REPORTING_ROUTES: readonly ReportingRoute[] = [
  { method: 'GET', path: /^\/api\/pos\/v1\/catalog\/snapshot$/ }, // posGetCatalogSnapshot
  { method: 'GET', path: /^\/api\/pos\/v1\/catalog\/deltas$/ }, // posGetCatalogDeltas
  { method: 'POST', path: /^\/api\/pos\/v1\/cashier-admissions$/ }, // posCreateCashierAdmission
  { method: 'POST', path: /^\/api\/pos\/v1\/cashier-admissions\/[^/]+\/end$/ }, // posEndCashierAdmission
  { method: 'GET', path: /^\/api\/pos\/v1\/cashier-admissions\/roster$/ }, // posListCashierAdmissionRoster
  { method: 'POST', path: /^\/api\/pos\/v1\/shifts$/ }, // openShift
  { method: 'POST', path: /^\/api\/pos\/v1\/shifts\/[^/]+\/cash-movements$/ }, // recordCashMovement
  { method: 'POST', path: /^\/api\/pos\/v1\/shifts\/[^/]+\/close$/ }, // closeShift
  { method: 'GET', path: /^\/api\/pos\/v1\/sale-history$/ }, // listSaleHistory
  { method: 'GET', path: /^\/api\/pos\/v1\/sale-history\/[^/]+$/ }, // readSaleHistoryDetail
  { method: 'POST', path: /^\/api\/pos\/v1\/sale-history\/[^/]+\/reprints$/ }, // recordSaleReprint
  { method: 'GET', path: /^\/api\/pos\/v1\/store\/cash-variance-policy$/ }, // posGetCashVariancePolicy
  { method: 'POST', path: /^\/api\/pos\/v1\/sales$/ }, // captureSale (device path; see the credential rule)
];

/** True when `method` + `path` (relative to the base URL, no query) is a reporting operation. */
export function isReportingRequest(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  const route = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return REPORTING_ROUTES.some((r) => r.method === verb && r.path.test(route));
}

export interface WithBuildIdentityOptions {
  /** The Backend-Core base URL the POS calls; only requests under it are considered. */
  readonly baseUrl: string;
  /** This build's identity, or null (unknown). Read per request; must be cheap. */
  readonly identity: () => BuildIdentity | null;
  /** The terminal's current sendable device token, or null. Never logged. */
  readonly readDeviceToken: () => Promise<string | null>;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return init?.method ?? (input instanceof Request ? input.method : 'GET');
}

function sourceHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

/** The route of `url` relative to `base`, or null when it is another origin or prefix. */
function routeUnder(base: URL, url: string): string | null {
  const target = new URL(url);
  if (target.origin !== base.origin) return null;
  const prefix = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  if (prefix !== '' && !target.pathname.startsWith(`${prefix}/`)) return null;
  return target.pathname.slice(prefix.length);
}

/** How long a request waits for the device token read before it goes out without the headers. */
export const TOKEN_READ_TIMEOUT_MS = 250;

/** The token read, or null when it fails or takes longer than the bound: a header never delays a request. */
async function boundedTokenRead(read: () => Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, TOKEN_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the request's bearer is exactly the terminal's current device token. */
function isDeviceBearer(headers: Headers, token: string | null): boolean {
  return token !== null && token !== '' && headers.get('authorization') === `Bearer ${token}`;
}

async function reportingHeaders(
  base: URL,
  opts: WithBuildIdentityOptions,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Headers | null> {
  const route = routeUnder(base, requestUrl(input));
  if (route === null || !isReportingRequest(methodOf(input, init), route)) return null;
  const identity = opts.identity();
  if (identity === null) return null;
  const headers = sourceHeaders(input, init);
  const token = await boundedTokenRead(opts.readDeviceToken);
  if (!isDeviceBearer(headers, token)) return null;
  headers.set(COMMIT_HEADER, identity.commit);
  if (identity.contractPin !== null) headers.set(CONTRACT_PIN_HEADER, identity.contractPin);
  else headers.delete(CONTRACT_PIN_HEADER);
  return headers;
}

/**
 * Adds the build identity headers to the device-token requests of the thirteen
 * reporting operations; every other request, and any request for which a value
 * or the credential cannot be established, goes through untouched.
 */
export function withBuildIdentity(fetchImpl: FetchLike, opts: WithBuildIdentityOptions): FetchLike {
  let base: URL | null;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    base = null;
  }
  return async (input, init) => {
    let headers: Headers | null = null;
    if (base !== null) {
      try {
        headers = await reportingHeaders(base, opts, input, init);
      } catch {
        // Best-effort: a header never fails or changes a request.
        headers = null;
      }
    }
    return fetchImpl(input, headers === null ? init : { ...init, headers });
  };
}
