/**
 * RT-113 P2 — client for the device-authenticated Backend-Core
 * `cashier-admissions` resource (RT-113 10763 D2 / D11; owner decision 10844;
 * fixes RT-182).
 *
 * Contract of record: Kemetra/Backend-Core
 * `packages/contracts/openapi/pos-cashier-admissions.openapi.yaml`
 * (1.0.0-draft; BC1 #696, BC2 #697):
 *
 *   POST /api/pos/v1/cashier-admissions                   posCreateCashierAdmission
 *   POST /api/pos/v1/cashier-admissions/{admission_id}/end posEndCashierAdmission
 *   GET  /api/pos/v1/cashier-admissions/roster            posListCashierAdmissionRoster
 *
 * The local types mirror the contract field for field (the 004 owner decision
 * keeps operator-surface types hand-written rather than regenerating
 * `src/shared/api-types.ts`); the tests validate every request body and every
 * response fixture against the vendored contract.
 *
 * Authentication: the paired terminal's device token as
 * `Authorization: Bearer <device_token>`, the same credential the catalogue
 * read-down uses (AD-7). No operator credential, no Clerk JWT, no scope field:
 * the server takes tenant and store from the device row. The token is read
 * in-process per call and is never logged, bridged or put in a body.
 *
 * The client never throws: every response resolves to a typed result and a
 * transport failure resolves to `no_connection` (resolve-on-reachable,
 * reject-only-on-transport, like `backend-client.ts`). No PIN or other secret
 * ever enters this module (AD-2): the admission call is the device's
 * attestation that it verified the PIN locally.
 */

const ADMISSIONS_PATH = '/api/pos/v1/cashier-admissions';
const ROSTER_PATH = '/api/pos/v1/cashier-admissions/roster';
const DEFAULT_TIMEOUT_MS = 15_000;

/** `PosCashierAdmissionOnlineRequest`. */
export interface CashierAdmissionOnlineRequest {
  mode: 'online';
  /** `users.id` (028 §16), the roster's `user_id`. */
  user_id: string;
  /** `true` only for "take over here" (D9); a heartbeat always sends `false`. */
  takeover: boolean;
  /** 16–128 printable ASCII, fresh per attempt. Never logged. */
  idempotency_key: string;
}

/** `PosCashierAdmissionAdmitted`. */
export interface CashierAdmissionAdmitted {
  kind: 'admitted';
  admission_id: string;
  offline_grace_seconds: number;
  admission_ttl_seconds: number;
  server_time: string;
  display_name: string;
}

/**
 * Outcome of `posCreateCashierAdmission`, in the contract's terms:
 *  - `admitted` / `active_elsewhere`: the two 200 variants;
 *  - `refused`: the generic 403 (cause never returned);
 *  - `device_unauthorized`: 401, or no device token held locally;
 *  - `idempotency_conflict`: 409; `rate_limited`: 429 (takeover limit);
 *  - `rejected`: 400, any other 4xx, or a 200 body outside the contract;
 *  - `unavailable`: 5xx; `no_connection`: transport failure or timeout.
 */
export type CashierAdmissionResult =
  | CashierAdmissionAdmitted
  | { kind: 'active_elsewhere' }
  | { kind: 'refused' }
  | { kind: 'device_unauthorized' }
  | { kind: 'idempotency_conflict' }
  | { kind: 'rate_limited' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }
  | { kind: 'no_connection' };

export type CashierAdmissionEndResult =
  | { kind: 'ended' }
  | { kind: 'device_unauthorized' }
  | { kind: 'failed' }
  | { kind: 'no_connection' };

/** `PosCashierRosterEntry` — minimum disclosure (D11). */
export interface CashierRosterEntry {
  user_id: string;
  /** Provider subject (`users.clerk_user_id`); the session `operator_id`. */
  operator_id: string;
  display_name: string;
}

export type CashierRosterResult =
  | { kind: 'roster'; cashiers: CashierRosterEntry[] }
  | { kind: 'device_unauthorized' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }
  | { kind: 'no_connection' };

export interface CashierAdmissionClient {
  admit(req: CashierAdmissionOnlineRequest): Promise<CashierAdmissionResult>;
  /** Idempotent and non-disclosing server-side; callers treat it as best-effort. */
  end(admissionId: string): Promise<CashierAdmissionEndResult>;
  listRoster(): Promise<CashierRosterResult>;
}

export interface CreateCashierAdmissionClientDeps {
  /** Backend-Core base URL. */
  baseUrl: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** The paired terminal's device token, or null when none is held. */
  getDeviceToken: () => Promise<string | null>;
  timeoutMs?: number;
}

type Sent =
  | { kind: 'response'; response: Response }
  | { kind: 'no_connection' }
  | { kind: 'no_token' };

export function createCashierAdmissionClient(
  deps: CreateCashierAdmissionClientDeps,
): CashierAdmissionClient {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Sent> {
    const token = await deps.getDeviceToken();
    if (token === null || token.length === 0) return { kind: 'no_token' };
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return { kind: 'response', response: await deps.fetch(`${root}${path}`, init) };
    } catch {
      return { kind: 'no_connection' };
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  }

  return {
    async admit(req) {
      const sent = await send(ADMISSIONS_PATH, 'POST', {
        mode: 'online',
        user_id: req.user_id,
        takeover: req.takeover,
        idempotency_key: req.idempotency_key,
      } satisfies CashierAdmissionOnlineRequest);
      if (sent.kind === 'no_token') return { kind: 'device_unauthorized' };
      if (sent.kind === 'no_connection') return sent;
      const { status } = sent.response;
      if (status === 200) return interpretAdmission(await readJson(sent.response));
      return mapAdmissionStatus(status);
    },

    async end(admissionId) {
      const sent = await send(`${ADMISSIONS_PATH}/${encodeURIComponent(admissionId)}/end`, 'POST');
      if (sent.kind === 'no_token') return { kind: 'device_unauthorized' };
      if (sent.kind === 'no_connection') return sent;
      if (sent.response.status === 401) return { kind: 'device_unauthorized' };
      // Every non-401 answer is informational: `end` is idempotent and the
      // local tear-down is authoritative.
      return sent.response.ok ? { kind: 'ended' } : { kind: 'failed' };
    },

    async listRoster() {
      const sent = await send(ROSTER_PATH, 'GET');
      if (sent.kind === 'no_token') return { kind: 'device_unauthorized' };
      if (sent.kind === 'no_connection') return sent;
      const { status } = sent.response;
      if (status === 401) return { kind: 'device_unauthorized' };
      if (status >= 500) return { kind: 'unavailable' };
      if (status !== 200) return { kind: 'rejected' };
      return interpretRoster(await readJson(sent.response));
    },
  };
}

function mapAdmissionStatus(status: number): CashierAdmissionResult {
  if (status === 401) return { kind: 'device_unauthorized' };
  if (status === 403) return { kind: 'refused' };
  if (status === 409) return { kind: 'idempotency_conflict' };
  if (status === 429) return { kind: 'rate_limited' };
  if (status >= 500) return { kind: 'unavailable' };
  return { kind: 'rejected' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

/** Allowlist-parse a 200 body; anything outside the contract is `rejected`. */
function interpretAdmission(parsed: unknown): CashierAdmissionResult {
  if (!isRecord(parsed)) return { kind: 'rejected' };
  if (parsed['kind'] === 'active_elsewhere') return { kind: 'active_elsewhere' };
  if (parsed['kind'] !== 'admitted') return { kind: 'rejected' };
  const { admission_id, offline_grace_seconds, admission_ttl_seconds, server_time, display_name } =
    parsed;
  if (
    !isNonEmptyString(admission_id) ||
    !isIntegerAtLeast(offline_grace_seconds, 0) ||
    !isIntegerAtLeast(admission_ttl_seconds, 1) ||
    typeof server_time !== 'string' ||
    typeof display_name !== 'string'
  ) {
    return { kind: 'rejected' };
  }
  return {
    kind: 'admitted',
    admission_id,
    offline_grace_seconds,
    admission_ttl_seconds,
    server_time,
    display_name,
  };
}

function interpretRoster(parsed: unknown): CashierRosterResult {
  if (!isRecord(parsed) || !Array.isArray(parsed['cashiers'])) return { kind: 'rejected' };
  const cashiers: CashierRosterEntry[] = [];
  for (const entry of parsed['cashiers']) {
    if (!isRecord(entry)) return { kind: 'rejected' };
    const { user_id, operator_id, display_name } = entry;
    if (!isNonEmptyString(user_id) || !isNonEmptyString(operator_id)) return { kind: 'rejected' };
    if (typeof display_name !== 'string') return { kind: 'rejected' };
    // Allowlist: only the three minimum-disclosure fields cross this layer.
    cashiers.push({ user_id, operator_id, display_name });
  }
  return { kind: 'roster', cashiers };
}
