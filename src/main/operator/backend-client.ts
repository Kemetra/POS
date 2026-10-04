/**
 * 004-operator-session — Data-Pulse-2 client for Wave 1 + Wave 3 + Wave 4.1 endpoints.
 *
 * Defines the local request/response types matching the merged
 * Wave 1, Wave 3, and Wave 4.1 contracts (per owner decision: do NOT regenerate
 * `src/shared/api-types.ts` from OpenAPI in S1/S4/S5). The shapes here
 * mirror `specs/004-operator-session/contracts/backend-endpoints.md`
 * Endpoints 1–4 + 6 + 7 verbatim.
 *
 *   POST /api/pos/v1/operators/sign-in          (Wave 1 — Endpoint 2)
 *   POST /api/pos/v1/operators/sign-out          (Wave 1 — Endpoint 3)
 *   GET  /api/pos/v1/operators/roster            (Wave 3 — Endpoint 1)
 *   POST /api/pos/v1/operators/takeover/confirm  (Wave 3 — Endpoint 4)
 *   GET  /api/pos/v1/shifts/stuck                (Wave 4.1 — Endpoint 7)
 *
 * RT-113 P2 retired Endpoint 6 (`GET /operators/active-session`): it was the
 * cashier path's only use and is Clerk + manager gated on Backend-Core
 * (RT-182). The cashier path uses `cashier-admission-client.ts` instead; the
 * roster below remains for the manager PIN-provisioning path only.
 *
 * The Clerk JWT travels in the `Authorization: Bearer …` header; the
 * device token travels in the platform's existing terminal-token
 * header (defined once at the platform level by 001/002). The
 * password NEVER appears anywhere in this layer (Wave 1 path b /
 * AD-2). The body of `/sign-in` carries `kind` + a
 * `device_token_attestation` — no `password`, no `identifier`,
 * no `pin`. The cashier PIN NEVER crosses this layer (AD-2).
 */

import type { Role } from '../../shared/operator/role.js';

// ─── Wave 1 — Sign-in ────────────────────────────────────────────────────────

export interface BackendSignInRequest {
  /** Discriminator. Wave 1 only ships `manager_admin`. */
  kind: 'manager_admin';
  /** Terminal-side proof of device-token possession (per 002). */
  device_token_attestation: string;
}

export interface BackendSignInOperator {
  id: string;
  /**
   * Provider-neutral identity key = DP-2 `users.id` (028 §16). Distinct from
   * `id` (= `clerk_user_id`, the v1 bridge). Surfaced by DP-2 033; consumed by
   * POS-017 to re-anchor the offline-PIN store off a provider-independent key.
   */
  user_id: string;
  display_name: string;
  role: Role;
  tenant_id: string;
  branch_id: string;
}

export interface BackendSignInSuccess {
  kind: 'signed_in';
  operator: BackendSignInOperator;
  operator_session: {
    id: string;
    issued_at: string;
  };
  /**
   * 016-operator-envelope-adoption (D5) — the opaque `pos_operator` envelope
   * minted by DP-2 #559 on sign-in / takeover (hash-once: returned once, `null`
   * on replay). POS treats it as an UNSTRUCTURED bearer secret — no parsing, no
   * claim inspection (G7 provider-neutrality). Held in-process in the `jwt-holder`
   * seam and presented as `Authorization: Bearer <envelope>` on the sale-sync POST;
   * NEVER bridged, NEVER logged, NEVER in any body (P7/P8). Optional/nullable:
   * absent on legacy/older backends, `null` on a replayed sign-in.
   *
   * `BackendTakeoverConfirmResponse` is a union over this interface, so this single
   * field covers BOTH the sign-in and the takeover-confirm success envelopes.
   */
  pos_operator_envelope?: string | null;
}

export interface BackendTakeoverRequired {
  kind: 'takeover_required';
}

export type BackendSignInResponse =
  | BackendSignInSuccess
  | BackendTakeoverRequired
  | { kind: 'refused' }
  | { kind: 'no_connection' };

// ─── Wave 1 — Sign-out ───────────────────────────────────────────────────────

export interface BackendSignOutRequest {
  session_id: string;
}

export type BackendSignOutResponse =
  | { kind: 'signed_out' }
  | { kind: 'refused' }
  | { kind: 'no_connection' };

// ─── Wave 3 — Roster (Endpoint 1) ────────────────────────────────────────────

export interface BackendRosterCashier {
  id: string;
  /**
   * 019-cashier-pin-provisioning — the cashier's provider-neutral identifier
   * (028 §16 = DP-2 `users.id`). OPTIONAL on the wire: present once DP-2 ships
   * the roster `user_id` field (017 OUTBOX), absent until then. The provision
   * handler keys the born-neutral PIN row off it and refuses `not_ready` when
   * it is absent (FR-11). Allowlisted (defence-in-depth) so it threads through
   * to the handler; the renderer-facing `BranchRosterCashier` does NOT carry it
   * (the clerk↔neutral mapping stays main-side — Constitution VII).
   */
  user_id?: string;
  display_name: string;
  /** Literal type: only cashier-role rows cross this layer (FR-006 / FR-031). */
  role: 'cashier';
}

export interface BackendRosterSuccess {
  kind: 'roster';
  cashiers: BackendRosterCashier[];
}

export type BackendRosterResponse =
  | BackendRosterSuccess
  | { kind: 'refused' }
  | { kind: 'no_connection' };

// ─── Wave 3 — Takeover confirm (Endpoint 4) ──────────────────────────────────

export interface BackendTakeoverConfirmRequest {
  /** Client-generated UUID v4 for P5 idempotency. */
  event_id: string;
  operator_id: string;
  device_token_attestation: string;
}

/** Success envelope is identical to sign-in per Endpoint 4 contract. */
export type BackendTakeoverConfirmResponse =
  | BackendSignInSuccess
  | { kind: 'refused' }
  | { kind: 'no_connection' };

// ─── Wave 4.1 — Stuck shifts (Endpoint 7) ────────────────────────────────────

/** One row in the stuck-shift list (per s5-stuck-shift-discovery-verification.md §3). */
export interface BackendStuckShiftRow {
  shift_id: string;
  /** Display label only — MUST NOT be email or Clerk user id (FR-032). */
  cashier_display_name: string;
  terminal_label: string;
  opened_at: string;
  duration_minutes: number;
}

export interface BackendStuckShiftsSuccess {
  kind: 'ok';
  shifts: BackendStuckShiftRow[];
}

export type BackendStuckShiftsResponse =
  | BackendStuckShiftsSuccess
  | { kind: 'refused' }
  | { kind: 'no_connection' };

// ─── Client interface ─────────────────────────────────────────────────────────

/**
 * Protocol the handler depends on. The production implementation
 * (`createBackendClient` below) wraps `fetch` with the device-token +
 * Authorization headers; tests inject a fake.
 */
export interface BackendClient {
  signIn(req: BackendSignInRequest, jwt: string): Promise<BackendSignInResponse>;
  signOut(req: BackendSignOutRequest, jwt: string): Promise<BackendSignOutResponse>;
  /**
   * GET /api/pos/v1/operators/roster — sent with no credential. Backend-Core
   * requires a Clerk JWT plus a manager-eligible role (RT-150), so this route
   * 401s as called (RT-182). The cashier picker no longer uses it (RT-113 P2:
   * `cashier-admission-client.ts`); only manager PIN provisioning still does.
   */
  listRoster(branchId: string): Promise<BackendRosterResponse>;
  /** POST /api/pos/v1/operators/takeover/confirm */
  confirmTakeover(
    req: BackendTakeoverConfirmRequest,
    jwt: string,
  ): Promise<BackendTakeoverConfirmResponse>;
  /** GET /api/pos/v1/shifts/stuck — manager/admin JWT required (AD-2; cashier MUST NOT call this). */
  getStuckShifts(branchId: string, jwt: string): Promise<BackendStuckShiftsResponse>;
}

// ─── Paths and defaults ───────────────────────────────────────────────────────

const SIGN_IN_PATH = '/api/pos/v1/operators/sign-in';
const SIGN_OUT_PATH = '/api/pos/v1/operators/sign-out';
const ROSTER_PATH = '/api/pos/v1/operators/roster';
const TAKEOVER_CONFIRM_PATH = '/api/pos/v1/operators/takeover/confirm';
const STUCK_SHIFTS_PATH = '/api/pos/v1/shifts/stuck';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CreateBackendClientDeps {
  /** Data-Pulse-2 base URL, e.g. `https://api.example.test`. */
  baseUrl: string;
  /** `fetch` implementation. Production binds the global; tests inject. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Override the request timeout in tests. */
  timeoutMs?: number;
}

/**
 * Production `BackendClient` for Data-Pulse-2 Wave 1 + Wave 3 endpoints.
 *
 * Resolve-on-reachable / reject-only-on-transport contract (matching
 * 002's `network.ts`): every backend response — including 4xx/5xx —
 * resolves to a typed result. Network errors (DNS/TLS/refused/timeout)
 * resolve to `{ kind: 'no_connection' }`. The function NEVER throws,
 * so callers do not need a try/catch wrapper.
 *
 * Failure-mode collapse: every 4xx/5xx maps to `refused` (PR-2 — no
 * factor distinction).
 *
 * Redaction: the `Authorization` header value (the JWT) is held only
 * in the `init.headers` object passed to fetch and never logged.
 * No PIN data ever enters any method in this client (AD-2).
 */
export function createBackendClient(deps: CreateBackendClientDeps): BackendClient {
  const { fetch: fetchImpl, baseUrl } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = baseUrl.replace(/\/$/, '');

  /**
   * Shared request skeleton (resolve-on-reachable / reject-only-on-transport):
   * transport error → no_connection; non-2xx → refused (PR-2 failure-mode
   * collapse); unparseable JSON body → refused; else the endpoint interpreter.
   */
  async function fetchAndInterpret<T>(
    url: string,
    init: RequestInit,
    interpret: (parsed: unknown) => T,
  ): Promise<T | { kind: 'refused' } | { kind: 'no_connection' }> {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      return { kind: 'no_connection' };
    }
    if (!response.ok) return { kind: 'refused' };
    let parsed: unknown;
    try {
      parsed = (await response.json()) as unknown;
    } catch {
      return { kind: 'refused' };
    }
    return interpret(parsed);
  }

  const jsonPost = (jwt: string, body: unknown): RequestInit => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    signIn(req: BackendSignInRequest, jwt: string): Promise<BackendSignInResponse> {
      return fetchAndInterpret(
        `${root}${SIGN_IN_PATH}`,
        jsonPost(jwt, req),
        interpretSignInResponse,
      );
    },

    async signOut(req: BackendSignOutRequest, jwt: string): Promise<BackendSignOutResponse> {
      let response: Response;
      try {
        response = await fetchImpl(`${root}${SIGN_OUT_PATH}`, jsonPost(jwt, req));
      } catch {
        return { kind: 'no_connection' };
      }
      if (!response.ok) return { kind: 'refused' };
      // Body is informational — sign-out is idempotent and the
      // client treats the local tear-down as authoritative
      // regardless of body shape.
      return { kind: 'signed_out' };
    },

    listRoster(branchId: string): Promise<BackendRosterResponse> {
      return fetchAndInterpret(
        `${root}${ROSTER_PATH}?branch_id=${encodeURIComponent(branchId)}`,
        { method: 'GET', signal: AbortSignal.timeout(timeoutMs) },
        interpretRosterResponse,
      );
    },

    confirmTakeover(
      req: BackendTakeoverConfirmRequest,
      jwt: string,
    ): Promise<BackendTakeoverConfirmResponse> {
      return fetchAndInterpret(
        `${root}${TAKEOVER_CONFIRM_PATH}`,
        jsonPost(jwt, req),
        interpretTakeoverConfirmResponse,
      );
    },

    getStuckShifts(branchId: string, jwt: string): Promise<BackendStuckShiftsResponse> {
      return fetchAndInterpret(
        `${root}${STUCK_SHIFTS_PATH}?branch_id=${encodeURIComponent(branchId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${jwt}` },
          signal: AbortSignal.timeout(timeoutMs),
        },
        interpretStuckShiftsResponse,
      );
    },
  };
}

// ─── Response interpreters ────────────────────────────────────────────────────

/** Operator-summary fields that must all be strings (allowlist). */
const OPERATOR_STRING_FIELDS = ['id', 'user_id', 'display_name', 'tenant_id', 'branch_id'];

/** Allowlist-parse the operator summary; null on any shape miss. */
function parseOperatorSummary(
  op: Record<string, unknown> | undefined,
): BackendSignInOperator | null {
  if (op === undefined) return null;
  if (!OPERATOR_STRING_FIELDS.every((f) => typeof op[f] === 'string')) return null;
  const role = op['role'];
  if (role !== 'cashier' && role !== 'manager' && role !== 'admin') return null;
  return {
    id: op['id'] as string,
    user_id: op['user_id'] as string,
    display_name: op['display_name'] as string,
    role,
    tenant_id: op['tenant_id'] as string,
    branch_id: op['branch_id'] as string,
  };
}

function interpretSignInResponse(parsed: unknown): BackendSignInResponse {
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'refused' };
  const v = parsed as Record<string, unknown>;
  if (v['kind'] === 'takeover_required') return { kind: 'takeover_required' };
  if (v['kind'] !== 'signed_in') return { kind: 'refused' };

  const operator = parseOperatorSummary(v['operator'] as Record<string, unknown> | undefined);
  if (operator === null) return { kind: 'refused' };

  const sess = v['operator_session'] as Record<string, unknown> | undefined;
  if (sess === undefined) return { kind: 'refused' };
  if (typeof sess['id'] !== 'string' || typeof sess['issued_at'] !== 'string') {
    return { kind: 'refused' };
  }
  // 016 C-1 (D5) / AD-SALE-CAPTURE-2: explicitly preserve the opaque operator-
  // authorization envelope. DP-2 returns it NESTED at `operator_session.envelope`
  // (canonical contract `pos-operators.openapi.yaml` PosOperatorSessionSummary;
  // `additionalProperties:false` makes a top-level field contract-illegal), so we
  // read it off the already-parsed `sess` object — NOT a top-level `v[...]` field.
  // The allowlist above silently drops unknown fields, so without this read the D5
  // credential swap would no-op with a green suite (the prior top-level read did
  // exactly that — it always saw `undefined` → empty envelope → sale-sync gate
  // closed for every role; see AD-SALE-CAPTURE-2). We FLATTEN it onto POS's own
  // top-level `pos_operator_envelope` (the `BackendSignInSuccess` internal shape).
  // Validate `string | null | absent` only (treat the envelope as an unstructured
  // bearer secret — no parsing, no claim inspection, G7); any other type is a
  // malformed response and collapses to `refused`, matching the existing posture.
  const rawEnvelope = sess['envelope'];
  if (rawEnvelope !== undefined && rawEnvelope !== null && typeof rawEnvelope !== 'string') {
    return { kind: 'refused' };
  }
  return {
    kind: 'signed_in',
    operator,
    operator_session: {
      id: sess['id'],
      issued_at: sess['issued_at'],
    },
    // Preserved verbatim: `string` when present, `null` on a replayed sign-in,
    // omitted only when truly absent (legacy/older backend).
    ...(rawEnvelope === undefined ? {} : { pos_operator_envelope: rawEnvelope }),
  };
}

/**
 * Allowlist-parse one roster entry; null on any shape miss. Allowlist: id,
 * display_name, role, and the OPTIONAL 019 user_id — every other field
 * (email/phone/password_hash/…) is stripped by construction. user_id is
 * threaded only when the backend actually supplies it (string); absent →
 * omitted, so pre-DP-2 entries stay {id, display_name, role}.
 */
function parseRosterCashier(entry: unknown): BackendRosterCashier | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e['id'] !== 'string') return null;
  if (typeof e['display_name'] !== 'string') return null;
  if (e['role'] !== 'cashier') return null;
  const cashier: BackendRosterCashier = {
    id: e['id'],
    display_name: e['display_name'],
    role: 'cashier',
  };
  if (typeof e['user_id'] === 'string') cashier.user_id = e['user_id'];
  return cashier;
}

function interpretRosterResponse(parsed: unknown): BackendRosterResponse {
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'refused' };
  const v = parsed as Record<string, unknown>;
  if (!Array.isArray(v['cashiers'])) return { kind: 'refused' };
  const cashiers: BackendRosterCashier[] = [];
  for (const entry of v['cashiers']) {
    const cashier = parseRosterCashier(entry);
    if (cashier === null) return { kind: 'refused' };
    cashiers.push(cashier);
  }
  return { kind: 'roster', cashiers };
}

function interpretTakeoverConfirmResponse(parsed: unknown): BackendTakeoverConfirmResponse {
  const res = interpretSignInResponse(parsed);
  // takeover_required is not a valid confirm outcome — treat as refused.
  if (res.kind === 'takeover_required') return { kind: 'refused' };
  return res;
}

/**
 * Allowlist-parse one stuck-shift row; null on any shape miss. Only the five
 * documented fields cross this layer (FR-032).
 */
function parseStuckShiftRow(entry: unknown): BackendStuckShiftRow | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e['shift_id'] !== 'string') return null;
  if (typeof e['cashier_display_name'] !== 'string') return null;
  if (typeof e['terminal_label'] !== 'string') return null;
  if (typeof e['opened_at'] !== 'string') return null;
  if (typeof e['duration_minutes'] !== 'number') return null;
  return {
    shift_id: e['shift_id'],
    cashier_display_name: e['cashier_display_name'],
    terminal_label: e['terminal_label'],
    opened_at: e['opened_at'],
    duration_minutes: e['duration_minutes'],
  };
}

function interpretStuckShiftsResponse(parsed: unknown): BackendStuckShiftsResponse {
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'refused' };
  const v = parsed as Record<string, unknown>;
  if (v['kind'] !== 'ok') return { kind: 'refused' };
  if (!Array.isArray(v['shifts'])) return { kind: 'refused' };
  const shifts: BackendStuckShiftRow[] = [];
  for (const entry of v['shifts']) {
    const row = parseStuckShiftRow(entry);
    if (row === null) return { kind: 'refused' };
    shifts.push(row);
  }
  return { kind: 'ok', shifts };
}
