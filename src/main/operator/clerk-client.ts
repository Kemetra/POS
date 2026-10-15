/**
 * 004-operator-session — Clerk credential exchange (Wave 1, path b).
 *
 * The POS terminal exchanges the operator-supplied identifier +
 * password against Clerk's public sign-in API to obtain a fresh Clerk
 * session JWT. Data-Pulse-2 then verifies that JWT via JWKS — the
 * password NEVER reaches Data-Pulse-2 (AD-2 / Constitution v1.5.1).
 *
 * The exchange happens in the main process so credentials never live
 * in the renderer beyond the single bridge hop. The published
 * `@clerk/clerk-js` package is a browser-shaped library that requires
 * `window`/`document` globals on first construction — it cannot be
 * instantiated from the Electron main process (Node context, no DOM).
 * The production exchanger therefore calls Clerk's documented public
 * Frontend API directly via `fetch`. The spec authorises both paths
 * ("Frontend SDK / public APIs" — see contracts/backend-endpoints.md
 * Endpoint 2 revision note + coordination/wave1-alignment-decision.md).
 *
 * The exchanger MUST NOT echo the password into any thrown error,
 * console line, log line, or returned value (PR-1). Success returns a
 * JWT + minimal operator metadata; failure returns a generic refusal
 * marker — `kind: 'refused'` with NO factor-distinguishing detail
 * (NFR-003 / PR-2).
 */

import { isRole, type Role } from '../../shared/operator/role.js';

export interface ClerkExchangeRequest {
  identifier: string;
  password: string;
}

export interface ClerkExchangeSuccess {
  kind: 'ok';
  /** Clerk session JWT (Bearer token for Data-Pulse-2). */
  jwt: string;
  /** Clerk user id (== `sub` claim). */
  operator_id: string;
  /** Best display name from Clerk's user record. */
  display_name: string;
  /** Role from Clerk's public metadata, mapped to the closed Role set. */
  role: Role;
}

export type ClerkExchangeResult =
  | ClerkExchangeSuccess
  | { kind: 'refused' }
  | { kind: 'no_connection' };

/**
 * Protocol the sign-in handler depends on. Tests inject a simple
 * fake; production wires `createClerkExchanger` below.
 */
export interface ClerkExchanger {
  exchange(req: ClerkExchangeRequest): Promise<ClerkExchangeResult>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface CreateClerkExchangerDeps {
  /** Clerk Frontend API base URL, e.g. `https://clerk.example.com`. */
  frontendApiBaseUrl: string;
  /** `fetch` implementation. Production binds the global; tests inject a fake. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Override the request timeout in tests. */
  timeoutMs?: number;
}

/**
 * Decode the Frontend API host from a Clerk publishable key.
 *
 * Format (Clerk public docs): `pk_(test|live)_<base64-url-encoded
 * frontend-api-host>$`. The terminating `$` is part of the base64
 * payload (a Clerk delimiter), not the host itself. Returns `null`
 * if the key is malformed.
 *
 * The publishable key itself is NOT a secret — it is intended for
 * client-side embedding. Surfacing it in logs is acceptable; we still
 * keep it out of error messages by convention.
 */
export function decodeFrontendApiBaseUrl(publishableKey: string): string | null {
  const prefix = ['pk_test_', 'pk_live_'].find((p) => publishableKey.startsWith(p));
  if (prefix === undefined) return null;
  const encoded = publishableKey.slice(prefix.length);
  // Some keys carry a literal `$` AFTER the base64 (older Clerk form); tolerate
  // that by stripping a trailing `$` on the encoded value too.
  const encodedStripped = encoded.endsWith('$') ? encoded.slice(0, -1) : encoded;
  if (encodedStripped.length === 0) return null;
  let decoded: string;
  try {
    // Buffer is available in the Electron main process (Node context).
    decoded = Buffer.from(encodedStripped, 'base64').toString('utf-8').trim();
  } catch {
    return null;
  }
  // Clerk's CURRENT format encodes the delimiter INSIDE the base64: the decoded
  // value is `<frontend-api-host>$` (e.g. `clerk.acme.com$`). Strip the trailing
  // `$` from the DECODED string — the earlier encoded-level strip does not catch
  // it because the `$` is part of the base64 payload, not appended to the key.
  const host = decoded.endsWith('$') ? decoded.slice(0, -1) : decoded;
  // The host is a hostname like `clerk.acme.com`. Validate shape defensively —
  // refuse anything containing whitespace, slash, or scheme markers (no
  // protocol-confusion attacks via env-var tampering).
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;
  return `https://${host}`;
}

/**
 * Production `ClerkExchanger` backed by Clerk's public Frontend API.
 *
 * Clerk does NOT return the session JWT inline on sign-in — the token is
 * minted by a SEPARATE call. The real two-call flow:
 *
 *   1. POST {fapi}/v1/client/sign_ins
 *      body: identifier=<email>&strategy=password&password=<pw>
 *      Content-Type: application/x-www-form-urlencoded
 *      On success (200) returns a `client` object whose `sessions[0]` carries
 *      the created session `id` + `user` (but NO inline `jwt`). The CLIENT
 *      identity needed by the mint call is returned in the `Authorization`
 *      RESPONSE header — a rotating client token (Clerk sets
 *      `access-control-expose-headers: Authorization` precisely so this can be
 *      replayed; it is NOT a `__client` cookie — Clerk does not set one here).
 *      A failed attempt (wrong password, unknown identifier, bot challenge, …)
 *      surfaces as 4xx — collapsed to `{ kind: 'refused' }`.
 *
 *   2. POST {fapi}/v1/client/sessions/{sessionId}/tokens
 *      with `Authorization: Bearer <client-token>` carried from step 1's
 *      response header. Returns `{ jwt }` — the session JWT (JWS, `sub` = Clerk
 *      user id). Without this client token the mint returns `signed_out`.
 *      DP-2 verifies this JWT via JWKS and reads ONLY `sub`; the operator's
 *      role/tenant/store are resolved server-side from the DB, so this client
 *      does NOT require any Clerk `public_metadata.role`.
 *
 * Network failures (either call) resolve to `{ kind: 'no_connection' }`. Any
 * non-2xx or malformed body resolves to `{ kind: 'refused' }` so the renderer
 * cannot distinguish among factor-level causes (PR-2).
 *
 * The password is consumed by `URLSearchParams.set(...)`; `JSON.stringify` is
 * NEVER called on a body containing it, so it cannot be enumerated through
 * `error.cause`. No returned field contains the password.
 */
export function createClerkExchanger(deps: CreateClerkExchangerDeps): ClerkExchanger {
  const { fetch: fetchImpl, frontendApiBaseUrl } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fapi = frontendApiBaseUrl.replace(/\/$/, '');

  return {
    async exchange(req: ClerkExchangeRequest): Promise<ClerkExchangeResult> {
      // ── Call 1: sign in ──────────────────────────────────────────────────
      const body = new URLSearchParams();
      body.set('identifier', req.identifier);
      body.set('strategy', 'password');
      body.set('password', req.password);

      let signInRes: Response;
      try {
        signInRes = await fetchImpl(`${fapi}/v1/client/sign_ins`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Transport failure. The thrown error can carry the URL + body in
        // `cause`; it MUST NOT propagate. Map to no_connection.
        return { kind: 'no_connection' };
      }
      if (!signInRes.ok) return { kind: 'refused' };

      // Capture the client token from the `Authorization` RESPONSE header
      // BEFORE consuming the body — it carries the client/session identity the
      // mint call needs (the missing piece that otherwise makes /tokens return
      // `signed_out`). Clerk does NOT set a `__client` cookie here.
      const clientToken = signInRes.headers.get('authorization');

      let signInParsed: unknown;
      try {
        signInParsed = (await signInRes.json()) as unknown;
      } catch {
        return { kind: 'refused' };
      }

      const session = extractActiveSession(signInParsed);
      if (session === null) return { kind: 'refused' };

      // ── Call 2: mint the session JWT ─────────────────────────────────────
      const mintHeaders: Record<string, string> = {};
      if (clientToken !== null && clientToken.length > 0) {
        mintHeaders['Authorization'] = `Bearer ${clientToken}`;
      }

      let mintRes: Response;
      try {
        mintRes = await fetchImpl(`${fapi}/v1/client/sessions/${session.id}/tokens`, {
          method: 'POST',
          headers: mintHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: 'no_connection' };
      }
      if (!mintRes.ok) return { kind: 'refused' };

      let mintParsed: unknown;
      try {
        mintParsed = (await mintRes.json()) as unknown;
      } catch {
        return { kind: 'refused' };
      }

      const jwt = extractMintedJwt(mintParsed);
      if (jwt === null) return { kind: 'refused' };

      return {
        kind: 'ok',
        jwt,
        operator_id: session.user.id,
        display_name: deriveDisplayName(session.user),
        role: mapRole(session.user.public_metadata?.role),
      };
    },
  };
}

interface ClerkSignInResponse {
  response?: {
    client?: ClerkClient;
  };
  client?: ClerkClient;
}

interface ClerkClient {
  sessions?: ClerkSession[];
}

interface ClerkSession {
  id?: string;
  status?: string;
  user?: ClerkUser;
}

interface ClerkUser {
  id?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  email_addresses?: Array<{ email_address?: string }>;
  public_metadata?: { role?: string };
}

/** A validated active session with a non-empty id and a user carrying an id. */
interface ResolvedSession {
  id: string;
  user: ClerkUser & { id: string };
}

/** Resolve + validate the active session (id + user.id) from a sign_ins body. */
function extractActiveSession(parsed: unknown): ResolvedSession | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as ClerkSignInResponse;
  // Clerk wraps client in `response.client` for some endpoints and `client`
  // for others. Read both defensively.
  const client = root.response?.client ?? root.client;
  const session = client?.sessions?.[0];
  if (session === undefined) return null;
  if (session.status !== undefined && session.status !== 'active') return null;
  if (typeof session.id !== 'string' || session.id.length === 0) return null;
  const user = session.user;
  if (user === undefined || typeof user.id !== 'string' || user.id.length === 0) return null;
  return { id: session.id, user: { ...user, id: user.id } };
}

/** Pull the minted JWT from the /tokens response. Returns null if absent/empty. */
function extractMintedJwt(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const jwt = (parsed as { jwt?: unknown }).jwt;
  return typeof jwt === 'string' && jwt.length > 0 ? jwt : null;
}

/**
 * Map Clerk `public_metadata.role` to the closed Role set. The role is NOT
 * authoritative here — DP-2 resolves the operator's role from its own DB at
 * `/operators/sign-in` (the JWT verifier reads only `sub`). Real operators
 * have empty `public_metadata`, so this MUST NOT gate the exchange. When the
 * metadata role is absent or outside the closed set, default to `manager`.
 *
 * The default MUST NOT be `cashier`: this exchanger serves ONLY the Clerk
 * `manager_admin` sign-in surface (cashiers authenticate by local PIN and never
 * reach Clerk). `exchange.role` flows into the takeover proto-store, and
 * `TakeoverHandler.confirmTakeover` dispatches `proto.role === 'cashier'` into
 * the local-only cashier path — which SKIPS `backend.confirmTakeover` and
 * creates a malformed local session with blank tenant/branch. Defaulting a
 * manager/admin operator to `cashier` would therefore downgrade a real
 * manager's takeover into a broken local session. `manager` keeps takeover on
 * the authoritative backend path; the truly-authoritative role still comes
 * from the DP-2 sign-in / takeover-confirm response.
 */
function mapRole(role: string | undefined): Role {
  return isRole(role) ? role : 'manager';
}

function deriveDisplayName(user: ClerkUser): string {
  const first = (user.first_name ?? '').trim();
  const last = (user.last_name ?? '').trim();
  if (first.length > 0 || last.length > 0) {
    return [first, last].filter((s) => s.length > 0).join(' ');
  }
  if (typeof user.username === 'string' && user.username.length > 0) return user.username;
  const email = user.email_addresses?.[0]?.email_address;
  if (typeof email === 'string' && email.length > 0) return email;
  return user.id ?? 'Operator';
}
