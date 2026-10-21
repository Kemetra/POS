/**
 * RT-792 — Descope credential exchange (RT-790 approach A).
 *
 * The Descope counterpart of `clerk-client.ts`: the POS main process exchanges
 * the manager/admin identifier + password against Descope's password sign-in
 * API for a session JWT, which Backend-Core then verifies (its
 * `IDENTITY_PROVIDER` verifier, RT-791). The password never reaches
 * Backend-Core and never leaves the main process except in this one request.
 *
 * It implements the existing `ClerkExchanger` protocol (name kept to avoid
 * churn) so the sign-in, takeover, re-auth and unlock paths are unchanged.
 * After the cutover Backend-Core returns the Descope userId as `operator.id`,
 * so the online re-auth identity check keeps comparing like with like.
 *
 * One call: `POST {base}/v1/auth/password/signin` with
 * `Authorization: Bearer <projectId>` and JSON `{ loginId, password }`. The
 * project id is a public client identifier, not a secret. The response's
 * `refreshJwt` is discarded: POS stores no refresh token (RT-358 re-auth).
 *
 * Same rules as the Clerk exchanger: non-2xx or a malformed body →
 * `{ kind: 'refused' }` with no factor detail (PR-2); a transport failure or
 * timeout → `{ kind: 'no_connection' }`. The password is consumed by one
 * `JSON.stringify` of the request body that is sent and never logged, and no
 * returned value or propagated error carries it (PR-1).
 */

import type { ClerkExchanger, ClerkExchangeRequest, ClerkExchangeResult } from './clerk-client.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/** The US (default-region) Descope API host. */
const DESCOPE_API_BASE_URL = 'https://api.descope.com';

/**
 * A Descope project id: `P` then letters/digits. A US project id is 28
 * characters; regional projects carry a longer id and use a regional API host,
 * which this exchanger does not serve (see `isRegionalDescopeProjectId`).
 */
const PROJECT_ID_PATTERN = /^P[A-Za-z0-9]{27,63}$/;

/** Descope SDKs treat an id of this length or longer as a regional project. */
const REGIONAL_PROJECT_ID_MIN_LENGTH = 32;

export function isDescopeProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

/**
 * True for a regional project id. Such projects answer on a regional host
 * (e.g. `api.euc1.descope.com`), not `api.descope.com`, so the resolver
 * refuses them rather than sign every attempt in to the wrong region.
 */
export function isRegionalDescopeProjectId(value: string): boolean {
  return value.length >= REGIONAL_PROJECT_ID_MIN_LENGTH;
}

export interface CreateDescopeExchangerDeps {
  /** Descope project id (validated by the resolver). */
  projectId: string;
  /** `fetch` implementation. Production binds the global; tests inject a fake. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Override the request timeout in tests. */
  timeoutMs?: number;
}

export function createDescopeExchanger(deps: CreateDescopeExchangerDeps): ClerkExchanger {
  const { fetch: fetchImpl, projectId } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async exchange(req: ClerkExchangeRequest): Promise<ClerkExchangeResult> {
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${DESCOPE_API_BASE_URL}/v1/auth/password/signin`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${projectId}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ loginId: req.identifier.trim(), password: req.password }),
          // A redirect would replay the password body to another URL: refuse it.
          redirect: 'error',
          signal,
        });
      } catch {
        // Transport failure or timeout. The thrown error can carry the request
        // in `cause`; it MUST NOT propagate. Map to no_connection.
        return { kind: 'no_connection' };
      }
      if (!res.ok) return { kind: 'refused' };

      let parsed: unknown;
      try {
        parsed = (await res.json()) as unknown;
      } catch {
        // A body cut off by the timeout is a connection problem, not bad credentials.
        return signal.aborted ? { kind: 'no_connection' } : { kind: 'refused' };
      }
      return toExchangeResult(parsed);
    },
  };
}

interface DescopeUser {
  userId?: unknown;
  name?: unknown;
  email?: unknown;
}

interface DescopeSignInResponse {
  sessionJwt?: unknown;
  user?: unknown;
}

/** The value as a plain property bag, or null for a non-object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Map a parsed sign-in body; anything missing or malformed is a generic refusal. */
function toExchangeResult(parsed: unknown): ClerkExchangeResult {
  const body: DescopeSignInResponse | null = asRecord(parsed);
  // An empty `sessionJwt` means the project hands tokens out in cookies only.
  const jwt = nonEmptyString(body?.sessionJwt);
  const user: DescopeUser | null = asRecord(body?.user);
  const userId = nonEmptyString(user?.userId);
  if (jwt === null || userId === null) return { kind: 'refused' };
  return {
    kind: 'ok',
    jwt,
    operator_id: userId,
    display_name: displayName(user, userId),
    // Same default as the Clerk exchanger, for the same takeover-safety reason
    // (see `mapRole` in clerk-client.ts): Backend-Core is the role authority.
    role: 'manager',
  };
}

function displayName(user: DescopeUser | null, userId: string): string {
  return trimmedText(user?.name) ?? trimmedText(user?.email) ?? userId;
}

/** A non-empty string, passed through unchanged (tokens and ids are never trimmed). */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function trimmedText(value: unknown): string | null {
  return typeof value === 'string' ? nonEmptyString(value.trim()) : null;
}
