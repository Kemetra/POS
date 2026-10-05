/**
 * 011-sale-sync-capture-up T061 — `createSaleSyncClient`.
 *
 * The CONCRETE live HTTP client behind the `SaleSyncClient` DI seam
 * (`sale-sync-client-types.ts`). POSTs a capture payload to DP2 `captureSale`
 * (`POST /api/pos/v1/sales`) and maps the HTTP outcome onto the engine's union
 * (`ok` / `divergent` / `transient` / `permanent` / `no_connection`).
 *
 * Established repo pattern (mirrors `operator/backend-client.ts`):
 *   • Factory `{ baseUrl, fetch, getOperatorToken, timeoutMs }`; `fetch` injected.
 *   • `AbortSignal.timeout(timeoutMs)`.
 *   • Resolve on EVERY reachable response; reject ONLY on a transport fault →
 *     `{ kind:'no_connection' }`. NEVER throws.
 *
 * Outcome mapping (contracts/README.md):
 *   200/201 → ok ·  409 → divergent (terminal payload divergence, RT-190) ·
 *   5xx / timeout → transient (retry) ·  425 / 429 → transient + `Retry-After`
 *   (RT-194) ·  400/422 (and other 4xx) → permanent (dead-letter) ·
 *   network/DNS/refused/timeout-before-response → no_connection.
 *
 * RT-15 S1 — `saleRef`: on 200/201 the body is the Backend-Core `Sale`
 * projection, whose required `saleRef` (UUID, = `sales.id`) is what the return
 * flow later addresses (`/api/pos/v1/sales/{saleRef}/returns`). The body is
 * parsed LENIENTLY (RT-15 D-g): only `saleRef` is read and every other key is
 * ignored, so a later additive `Sale` field never breaks capture. A missing /
 * unparseable body or a non-UUID `saleRef` still yields `ok` (the sale IS
 * captured server-side) with `saleRef: null`, and `onSaleRefUnavailable` is told
 * the reason — never the body or the rejected value (P7). A body that cannot be
 * READ (the stream fails or the timeout fires mid-body) is different: the answer
 * was lost in transit, so it maps to `transient` and the engine retries with the
 * SAME `Idempotency-Key` / `externalId`. That cannot double-capture — Backend-Core
 * dedups on the key (a same-key retry replays the stored 201) and on provenance
 * `(tenant, sourceSystem, externalId)` (a 200 replay) — and the replay carries
 * the same `saleRef`, which is then stored.
 *
 * RT-190 — 409: Backend-Core answers a capture 409 ONLY as the `Error` envelope
 * `{ error: { code: 'idempotency_key_conflict', … } }` — the key or the
 * provenance was reused with a DIFFERENT logical payload. Benign replays are
 * 201/200, never 409. So a 409 is `divergent`, never success. Its body is read
 * only to label the code from a closed set (`parseConflictCode`); a malformed
 * body, an unreadable body or any other code is `unrecognized` and is STILL
 * divergent (fail closed). The body text is never surfaced or logged (P7).
 * Bodies of every other non-2xx status are not read.
 *
 * RT-194 — 425: Backend-Core's `IdempotencyInterceptor` answers 425
 * `{ error: 'idempotency_in_progress', retryAfterSec: 2 }` with `Retry-After: 2`
 * while an earlier request with the SAME Idempotency-Key still holds the in-flight
 * marker — typically our own first attempt that hit the client timeout but is
 * still committing on the server. The sale is not rejected; it is being captured.
 * So 425 is `transient` (status alone decides; the body is not read), the engine
 * waits at least `Retry-After`, and the retry with the same key gets the 201/200
 * replay and its saleRef. 429 (per-device write rate limit) is handled the same
 * way. `Retry-After` is parsed by `parseRetryAfterMs` (seconds or HTTP-date,
 * clamped); a missing or invalid header leaves the normal backoff in charge.
 *
 * Auth (016 D5/D7, DP-2 #559): the `operatorAuthorization` scheme =
 * `Authorization: Bearer <pos_operator_envelope>` — the OPAQUE operator envelope
 * (NOT the Clerk JWT, NOT the device token). The envelope is read fresh per POST via
 * the injected `getOperatorToken` (the engine already gates the drain on a present
 * envelope and re-checks mid-drain; this is the per-request attach). It is an opaque
 * secret — attached to the outbound request only, NEVER parsed, NEVER logged, NEVER
 * placed in the payload, NEVER crossing the bridge (P7/P8/G7). 016 (D7):
 * `X-Device-Attestation` is RETIRED from the sale wire — the backend re-evaluates the
 * full operator predicate (membership/device/store/role/expiry) live per request from
 * the envelope-bound principal, so no device-trust attestation co-travels on the sale
 * POST. `Idempotency-Key` is the deterministic `payload.externalId` (REQUIRED on the
 * write); the backend dedups on `(tenant, sourceSystem, externalId)` so retries
 * collapse to one record.
 *
 * RT-224 step 2 — device path (Option B, Backend-Core #709, `sales.yaml`
 * 1.5.0-draft): `postSaleAsCashier(payload, operatorUserId)` sends the SAME wire
 * body plus `operatorUserId` (the `users.id` of the cashier who made the sale)
 * with `Authorization: Bearer <device token>` (the `device` scheme). The device
 * token is read fresh per POST through `getDeviceToken`; it is attached to the
 * request only — never logged, never in the body. `postSale` (the envelope) is
 * unchanged and never carries `operatorUserId`: an envelope request with it is
 * refused by the server. Device-path statuses map like the envelope path except
 * 401 → `device_unauthorized` (the device credential) and 403 → `refused` (the
 * server refused this sale's cashier claim; the status alone decides, the body
 * is not read).
 *
 * Wire-shape boundary: the internal `CaptureSalePayload` carries INTEGER MINOR
 * UNITS (`totalMinor`, `unitPriceMinor`, `lineAmountMinor`) and a numeric
 * `quantity`; the binding DP2 `CaptureSaleRequest` (deployed ref 6975f67,
 * `pos-sales/sales.yaml`) is strict (`additionalProperties: false`) and uses
 * exact-decimal STRING money (`DecimalAmount`, `numeric(19,4)`), a flat top-level
 * `posTotal`, a 3-letter `currencyCode`, and string `quantity`. This client is the
 * conversion boundary: it renames `totalMinor → posTotal`, converts every minor
 * amount to an exact decimal string via the currency minor-unit exponent (pure
 * string/integer math — NEVER a float), and emits ONLY the contract's allowed keys
 * (server-resolved tenant / store / actor fields are DROPPED — they would be
 * rejected by the strict boundary). Each `CaptureSaleLine` carries its own
 * `currencyCode` per the contract. The validation gate is the live smoke test:
 * a correct POST returns 200/201/409; a shape mismatch returns 400/422
 * (→ dead-letter, observable). Currency is single-store EGP in v1.
 */

import type { CaptureSalePayload } from './capture-payload.js';
import { parseRetryAfterMs } from './retry-after.js';
import type {
  CaptureConflictCode,
  SaleSyncClient,
  SaleSyncResult,
} from './sale-sync-client-types.js';

const SALES_PATH = '/api/pos/v1/sales';
const DEFAULT_TIMEOUT_MS = 15_000;
/** The capture currency when none is configured (v1 single-currency EGP); RT-15 returns reuse it. */
export const DEFAULT_CURRENCY_CODE = 'EGP';

/**
 * Unit-of-measure token sent on every `CaptureSaleLine.unit` (contract-required,
 * 1–50 chars). The internal cart/sale line snapshot carries NO unit of measure
 * (`LineSnapshot` has display_name / quantity / prices only), so a safe constant
 * is supplied at this wire boundary. `'unit'` is a neutral each/piece token.
 * OWNER-CONFIRM: if the platform expects a specific UoM vocabulary, surface it
 * through the snapshot and map it here instead of this default.
 */
const DEFAULT_LINE_UNIT = 'unit';

/** Minor-unit exponent by ISO-4217 currency (v1 single-currency-per-store = EGP). */
const CURRENCY_MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  EGP: 2,
  USD: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
};
const DEFAULT_MINOR_UNIT_EXPONENT = 2;

export function exponentFor(currencyCode: string): number {
  return CURRENCY_MINOR_UNIT_EXPONENT[currencyCode] ?? DEFAULT_MINOR_UNIT_EXPONENT;
}

/**
 * Integer minor units → exact-decimal string (the inverse of
 * `decimalStringToMinorUnits` in the read-down mapper). Pure string/integer math;
 * NEVER touches a JS float. Matches the DP2 `DecimalAmount` grammar
 * (`^-?[0-9]{1,15}(\.[0-9]{1,4})?$`): for exponent 0 it emits NO decimal point
 * (e.g. 100 → "100", never "100."); for exponent > 0 it emits exactly that many
 * fractional digits (e.g. 2550/exp2 → "25.50", 5/exp2 → "0.05", 0/exp2 → "0.00").
 */
export function minorUnitsToDecimalString(minor: number, exponent: number): string {
  // Money is integer minor units only. A non-safe integer (float, NaN, or a value
  // past Number.MAX_SAFE_INTEGER) would format to a wrong decimal string and put a
  // wrong amount on the wire — reject it at the source. The boundary (`toWireBody`,
  // and ultimately `postSale`) maps the throw to a `permanent` dead-letter.
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`minor units must be a safe integer; got ${String(minor)}`);
  }
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new Error(`exponent must be a non-negative integer; got ${String(exponent)}`);
  }
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor));
  if (exponent === 0) {
    return `${sign}${digits}`;
  }
  // Left-pad so there are at least `exponent + 1` digits (one for the integer part).
  const padded = digits.padStart(exponent + 1, '0');
  const cut = padded.length - exponent;
  const intPart = padded.slice(0, cut);
  const fracPart = padded.slice(cut);
  return `${sign}${intPart}.${fracPart}`;
}

export interface CreateSaleSyncClientDeps {
  /** Data-Pulse-2 base URL, e.g. `https://example.invalid` in tests/templates. */
  baseUrl: string;
  /** `fetch` implementation. Production binds the global; tests inject. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /**
   * In-process read of the operator session credential — the opaque `pos_operator`
   * ENVELOPE (016 D5, #559), held in the jwt-holder seam. The engine already pauses
   * the drain when this is null/empty (the M-1 envelope-present gate); defensively, a
   * null/empty here maps to `no_connection` (retryable — the sale stays pending)
   * rather than a POST without auth. Presented as `Authorization: Bearer <envelope>`
   * via the `operatorAuthorization` scheme. NEVER logged, NEVER in the body (P7/P8).
   */
  getOperatorToken: () => string | null;
  /**
   * RT-224 step 2: in-process read of the paired terminal's DEVICE token for the
   * `device` scheme of `postSaleAsCashier`; null/empty (or not wired) → no POST,
   * `no_connection` (the sale stays queued). NEVER logged, NEVER in the body.
   */
  getDeviceToken?: () => Promise<string | null>;
  /**
   * RT-224 step 2 (Codex P2 on #547): the CURRENT pairing's `terminal_id`, read
   * synchronously (`PairingStore.getCurrentTerminalId`). Checked after the device
   * token is read and immediately before the request, with no await in between:
   * a sale is sent only under the terminal it was made on. A re-pair completing
   * during the token read (a new token, a different terminal) → not sent,
   * `no_connection` (the sale stays pending, held under its old pairing by
   * RT-221; never dead-lettered). Not wired → fail closed (never sent).
   */
  currentTerminalId?: () => string | null;
  /** Called once per mismatch episode (re-armed by a matching send). No arguments. */
  onDeviceTerminalChanged?: () => void;
  /** ISO-4217 currency for the store (v1 single-currency). Defaults to EGP. */
  currencyCode?: string;
  /**
   * RT-15 S1: called when a 200/201 capture answer carried no usable `saleRef`.
   * Receives the sale's deterministic `externalId` (an opaque local id, no PII)
   * and a closed-set reason — never the body, never the rejected value.
   */
  onSaleRefUnavailable?: (info: SaleRefUnavailableInfo) => void;
  /** Override the request timeout in tests. */
  timeoutMs?: number;
  /** RT-194: epoch-ms clock for an HTTP-date `Retry-After`. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/**
 * The binding DP2 `CaptureSaleLine` wire shape (deployed ref 6975f67). Required:
 * lineName, unitPrice, currencyCode, quantity, lineAmount, unit. Optional
 * `taxAmount` is OMITTED — the internal model carries no per-line tax (tax is
 * header-level) — and the strict `additionalProperties: false` boundary rejects
 * unknown keys.
 *
 * Optional `tenantProductRef` (RT-30 / RT-35) is the line's Backend-Core Tenant
 * Catalog lineage. For a catalogue line the frozen `item_ref` (internal
 * `productRef`) IS `tenant_products.id` — read-down `product_id` → local
 * `products.product_id` → cart `item_ref` → `lines_json`. It is emitted only when
 * `productRef` has the UUID shape DP-2 accepts; otherwise the key is omitted
 * (ad-hoc lineage) so the sale is still captured and ERP posting reports an
 * explicit `unmapped_item`, rather than a 400 dead-lettering the sale.
 */
interface CaptureSaleLineWire {
  lineName: string;
  unitPrice: string;
  currencyCode: string;
  quantity: string;
  lineAmount: string;
  unit: string;
  tenantProductRef?: string;
}

/**
 * Mirrors DP-2's `z.string().uuid()` (zod 3.23.8) EXACTLY — 8-4-4-4-12 hex,
 * case-insensitive, no version/variant check. Stricter would silently drop
 * lineage DP-2 accepts; looser would 400 → dead-letter the sale.
 */
const DP2_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tenantProductRefFor(productRef: string): { tenantProductRef?: string } {
  return DP2_UUID_PATTERN.test(productRef) ? { tenantProductRef: productRef } : {};
}

/**
 * The binding DP2 `CaptureSaleRequest` wire body (deployed ref 6975f67,
 * `additionalProperties: false`). Only the contract's allowed keys appear:
 * tenant / store / actor are resolved server-side from auth and MUST NOT be sent.
 */
interface CaptureSaleWireBody {
  sourceSystem: 'pos-pulse';
  externalId: string;
  currencyCode: string;
  posTotal: string;
  occurredAt: string;
  lines: CaptureSaleLineWire[];
  /** RT-79: only when the payload carries tenders. No `reference` (D-A). */
  tenders?: CaptureSaleTenderWire[];
}

/** The DP-2 `SaleTender` wire shape (RT-10 D1) — `reference` is deliberately never sent. */
interface CaptureSaleTenderWire {
  method: 'cash' | 'card_external';
  amount: string;
}

/**
 * Pure transform: internal payload (integer minor units) → DP2 wire body.
 *
 * Validates every numeric money/quantity field is a safe integer at this boundary
 * before conversion — a corrupted upstream value (overflowing minor units, a float,
 * NaN) must never be silently rendered into a wrong decimal string and POSTed.
 * Throws on an invalid value; the only caller (`postSale`) catches it and maps to
 * `permanent` (a defect that will never succeed on retry → dead-letter), preserving
 * the client's "never throws" contract.
 */
export function toWireBody(payload: CaptureSalePayload, currencyCode: string): CaptureSaleWireBody {
  const exponent = exponentFor(currencyCode);
  // `quantity` is rendered via String(), not the money converter, so it needs its
  // own guard here; the *Minor fields are re-checked inside minorUnitsToDecimalString.
  for (const line of payload.lines) {
    if (!Number.isSafeInteger(line.quantity)) {
      throw new Error(
        `line ${line.lineRef} quantity must be a safe integer; got ${String(line.quantity)}`,
      );
    }
  }
  const tenders = tendersWire(payload, exponent);
  return {
    sourceSystem: payload.sourceSystem,
    externalId: payload.externalId,
    currencyCode,
    posTotal: minorUnitsToDecimalString(payload.totalMinor, exponent),
    occurredAt: payload.occurredAt,
    lines: payload.lines.map((line) => ({
      lineName: line.lineName,
      unitPrice: minorUnitsToDecimalString(line.unitPriceMinor, exponent),
      currencyCode,
      quantity: String(line.quantity),
      lineAmount: minorUnitsToDecimalString(line.lineAmountMinor, exponent),
      unit: DEFAULT_LINE_UNIT,
      ...tenantProductRefFor(line.productRef),
    })),
    ...(tenders === undefined ? {} : { tenders }),
  };
}

/**
 * RT-79: tender amounts minor -> exact decimal with the SAME exponent as `posTotal`.
 * Asserts sum(tenders) == totalMinor before anything is sent — a mismatch is a local
 * defect (it would only come back as 422 `sale_tender_mismatch`), so it throws and
 * `postSale` maps it to `permanent` (dead-letter, never POSTed).
 */
function tendersWire(
  payload: CaptureSalePayload,
  exponent: number,
): CaptureSaleTenderWire[] | undefined {
  const tenders = payload.tenders;
  if (tenders === undefined || tenders.length === 0) return undefined;
  let sum = 0;
  for (const t of tenders) {
    if (!Number.isSafeInteger(t.amountMinor)) {
      throw new Error(`tender ${t.method} amount must be a safe integer`);
    }
    sum += t.amountMinor;
  }
  if (sum !== payload.totalMinor) {
    throw new Error(`tenders sum ${String(sum)} != sale total ${String(payload.totalMinor)}`);
  }
  return tenders.map((t) => ({
    method: t.method,
    amount: minorUnitsToDecimalString(t.amountMinor, exponent),
  }));
}

/** Why a 200/201 capture answer yielded `saleRef: null` (closed set; no body content). */
export type SaleRefUnavailableReason = 'unparseable_body' | 'missing_sale_ref' | 'invalid_sale_ref';

export interface SaleRefUnavailableInfo {
  externalId: string;
  reason: SaleRefUnavailableReason;
}

export type SaleRefParse =
  | { saleRef: string }
  | { saleRef: null; reason: SaleRefUnavailableReason };

/**
 * RT-15 S1 — lenient read of `saleRef` from a capture 200/201 body (D-g).
 * Reads ONLY `saleRef`; unknown keys are allowed and ignored. The value must be
 * a string in the canonical UUID shape Backend-Core issues and checks
 * (`DP2_UUID_PATTERN`, case-insensitive); anything else is `null` + a reason.
 * Pure; never throws.
 */
export function parseSaleRef(bodyText: string): SaleRefParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { saleRef: null, reason: 'unparseable_body' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { saleRef: null, reason: 'unparseable_body' };
  }
  const value = (parsed as Record<string, unknown>)['saleRef'];
  if (value === undefined || value === null) {
    return { saleRef: null, reason: 'missing_sale_ref' };
  }
  if (typeof value !== 'string' || !DP2_UUID_PATTERN.test(value)) {
    return { saleRef: null, reason: 'invalid_sale_ref' };
  }
  return { saleRef: value };
}

const IDEMPOTENCY_KEY_CONFLICT = 'idempotency_key_conflict';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * RT-224 step 2: the device-path wire body — the envelope body plus
 * `operatorUserId`. Pure; throws like `toWireBody` on an invalid amount.
 */
export function toCashierWireBody(
  payload: CaptureSalePayload,
  currencyCode: string,
  operatorUserId: string,
): CaptureSaleWireBody & { operatorUserId: string } {
  return { ...toWireBody(payload, currencyCode), operatorUserId };
}

/**
 * RT-190 — label a capture 409 body from a closed set. Reads ONLY
 * `error.code`; returns `idempotency_key_conflict` when it is exactly that, and
 * `unrecognized` for anything else (unparseable JSON, a missing envelope, another
 * code). The label never carries server text (P7). Pure; never throws.
 */
export function parseConflictCode(bodyText: string): CaptureConflictCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return 'unrecognized';
  }
  const error = isRecord(parsed) ? parsed['error'] : undefined;
  const code = isRecord(error) ? error['code'] : undefined;
  return code === IDEMPOTENCY_KEY_CONFLICT ? IDEMPOTENCY_KEY_CONFLICT : 'unrecognized';
}

/** RT-190: read a 409 body for its code; an unreadable body is `unrecognized`. */
async function readConflictCode(response: Response): Promise<CaptureConflictCode> {
  try {
    return parseConflictCode(await response.text());
  } catch {
    return 'unrecognized';
  }
}

/** RT-194: the transient statuses whose `Retry-After` the engine honours. */
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([425, 429]);

/** RT-194: a transient 425/429 carries the parsed `Retry-After`, when valid. */
function withRetryAfter(response: Response, nowMs: number): SaleSyncResult {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), nowMs);
  return retryAfterMs === undefined ? { kind: 'transient' } : { kind: 'transient', retryAfterMs };
}

/** Map an HTTP status onto the engine's outcome union (contracts/README.md). */
export function classifyStatus(status: number): SaleSyncResult {
  // Status-only: `saleRef` comes from the body, which `postSale` reads for 200/201.
  if (status === 200 || status === 201) return { kind: 'ok', saleRef: null };
  // RT-190: a capture 409 is a terminal payload divergence, never success. The
  // status alone decides; `postSale` reads the body only to label the code.
  if (status === 409) return { kind: 'divergent', errorCode: 'unrecognized' };
  if (status >= 500) return { kind: 'transient' };
  // 401/403 — auth refusal. 016 (D5/R4): the credential is now the opaque
  // pos_operator ENVELOPE; an expired/revoked envelope legitimately 401/403s.
  // This is RETRYABLE (v1 renewal is via re-sign-in, which re-acquires a fresh
  // envelope into the holder and re-drains the row — G-5), NOT a permanent defect
  // — dead-lettering it would silently lose the sale. Classification UNCHANGED
  // from 011: still transient, retryable, never dead-letter (E-4). Treat as transient.
  if (status === 401 || status === 403) return { kind: 'transient' };
  // 429 — per-device write rate limit (DP-2 ADR 0009 / audit M-2). This is
  // TRANSIENT back-pressure: the device was briefly too fast, NOT a contract
  // defect. The sale is valid and WILL succeed on retry once the window rolls
  // (Retry-After). Dead-lettering it would permanently lose a good sale — the
  // same failure mode the 401/403 case above guards against. Treat as transient.
  // RT-194: 425 `idempotency_in_progress` — the same Idempotency-Key is still in
  // flight on the server. The sale is being captured, not rejected: transient,
  // never dead-letter. `postSale` adds the `Retry-After` delay for both.
  if (RETRY_AFTER_STATUSES.has(status)) return { kind: 'transient' };
  // Other 4xx (400/404/422/…) is a genuine validation/contract defect — the
  // request will not succeed on retry without intervention; dead-letter it.
  if (status >= 400) return { kind: 'permanent' };
  // Unexpected 2xx/3xx — treat as transient (don't lose the sale).
  return { kind: 'transient' };
}

/**
 * RT-224 step 2: the device path's status mapping. 401 is the device credential
 * (`device_unauthorized`, the sale stays queued) and 403 is the server's generic
 * `refused` for this sale's cashier claim — a per-sale outcome, never a device
 * revocation. Every other status maps exactly as on the envelope path.
 */
export function classifyDeviceStatus(status: number): SaleSyncResult {
  if (status === 401) return { kind: 'device_unauthorized' };
  if (status === 403) return { kind: 'refused' };
  return classifyStatus(status);
}

export function createSaleSyncClient(deps: CreateSaleSyncClientDeps): SaleSyncClient {
  const { fetch: fetchImpl, baseUrl, getOperatorToken } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const currencyCode = deps.currencyCode ?? DEFAULT_CURRENCY_CODE;
  const nowMs = deps.nowMs ?? Date.now;
  const root = baseUrl.replace(/\/$/, '');

  /**
   * One POST of an already-built wire body under ONE bearer credential; the
   * outcome is derived from the status by `classify`. Shared by both paths so
   * there is a single request site.
   */
  async function send(
    credential: string,
    body: CaptureSaleWireBody,
    externalId: string,
    classify: (status: number) => SaleSyncResult,
  ): Promise<SaleSyncResult> {
    let response: Response;
    try {
      response = await fetchImpl(`${root}${SALES_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 016 (D5): `operatorAuthorization` = opaque bearer envelope; RT-224:
          // `device` = the paired terminal's device token. Exactly one per
          // request. 016 (D7): X-Device-Attestation is RETIRED from the sale wire.
          Authorization: `Bearer ${credential}`,
          'Idempotency-Key': externalId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Transport fault (DNS / TLS / refused / timeout) — retryable.
      return { kind: 'no_connection' };
    }

    // The outcome is derived from the status only. RT-15 S1: for 200/201 the
    // body is read for `saleRef` and nothing else; RT-190: for 409 it is read
    // for the closed-set conflict code and nothing else. The raw body is never
    // surfaced or logged (P7). Other statuses' bodies are not read. RT-194: for
    // 425/429 only the `Retry-After` header is read.
    const result = classify(response.status);
    if (result.kind === 'divergent') {
      return { kind: 'divergent', errorCode: await readConflictCode(response) };
    }
    if (RETRY_AFTER_STATUSES.has(response.status)) return withRetryAfter(response, nowMs());
    if (result.kind !== 'ok') return result;

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      // The body stream failed after the status arrived (the timeout hit
      // mid-body, or the connection reset). The answer was lost in transit, not
      // malformed: retry. The retry reuses the same Idempotency-Key/externalId,
      // so Backend-Core replays the capture (201/200, same saleRef) instead of
      // recording a second sale; marking it synced now would lose the saleRef.
      return { kind: 'transient' };
    }
    const parsed = parseSaleRef(bodyText);
    if (parsed.saleRef === null) {
      try {
        deps.onSaleRefUnavailable?.({ externalId, reason: parsed.reason });
      } catch {
        // A failing warning hook must not turn a captured sale into a rejection
        // (`postSale` never rejects); the outcome below is unaffected.
      }
    }
    return { kind: 'ok', saleRef: parsed.saleRef };
  }

  /**
   * RT-224 step 2: the device token, read fresh per POST; null when there is none
   * (unpaired, not wired, empty). Codex P2: a failing read is "no token", never a
   * rejection.
   */
  async function readDeviceToken(): Promise<string | null> {
    try {
      const token = deps.getDeviceToken === undefined ? null : await deps.getDeviceToken();
      return token === null || token.length === 0 ? null : token;
    } catch {
      return null;
    }
  }

  // Codex P2 (#547): a terminal mismatch was reported and no matching send since.
  let terminalChangeReported = false;

  /** The current pairing is still the sale's terminal (fail closed when unknown). */
  function onSaleTerminal(payload: CaptureSalePayload): boolean {
    const current = deps.currentTerminalId?.() ?? null;
    if (current !== null && current === payload.terminalId) {
      terminalChangeReported = false;
      return true;
    }
    if (!terminalChangeReported) {
      terminalChangeReported = true;
      deps.onDeviceTerminalChanged?.();
    }
    return false;
  }

  return {
    async postSale(payload: CaptureSalePayload): Promise<SaleSyncResult> {
      const token = getOperatorToken();
      if (token === null || token.length === 0) {
        // No operator envelope: do not POST unauthenticated. The engine's
        // envelope-present gate (M-1) should have paused already; map to
        // no_connection so the sale stays pending.
        return { kind: 'no_connection' };
      }

      // The wire transform validates money/quantity are safe integers and throws on
      // a corrupted value. `postSale` must NEVER reject (sale-sync-client-types.ts),
      // and such a value will never succeed on retry, so map it to `permanent` —
      // the engine dead-letters it observably rather than the drain crashing.
      let body: CaptureSaleWireBody;
      try {
        body = toWireBody(payload, currencyCode);
      } catch {
        return { kind: 'permanent' };
      }
      return send(token, body, payload.externalId, classifyStatus);
    },

    async postSaleAsCashier(
      payload: CaptureSalePayload,
      operatorUserId: string,
    ): Promise<SaleSyncResult> {
      const deviceToken = await readDeviceToken();
      if (deviceToken === null) return { kind: 'no_connection' };
      let body: CaptureSaleWireBody;
      try {
        body = toCashierWireBody(payload, currencyCode, operatorUserId);
      } catch {
        return { kind: 'permanent' };
      }
      // Codex P2 (#547): no await between this check and the request below.
      if (!onSaleTerminal(payload)) return { kind: 'no_connection' };
      return send(deviceToken, body, payload.externalId, classifyDeviceStatus);
    },
  };
}
