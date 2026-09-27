/**
 * 011-sale-sync-capture-up T061 — `createSaleSyncClient`.
 *
 * The CONCRETE live HTTP client behind the `SaleSyncClient` DI seam
 * (`sale-sync-client-types.ts`). POSTs a capture payload to DP2 `captureSale`
 * (`POST /api/pos/v1/sales`) and maps the HTTP outcome onto the engine's union
 * (`ok` / `duplicate` / `transient` / `permanent` / `no_connection`).
 *
 * Established repo pattern (mirrors `operator/backend-client.ts`):
 *   • Factory `{ baseUrl, fetch, getOperatorToken, timeoutMs }`; `fetch` injected.
 *   • `AbortSignal.timeout(timeoutMs)`.
 *   • Resolve on EVERY reachable response; reject ONLY on a transport fault →
 *     `{ kind:'no_connection' }`. NEVER throws.
 *
 * Outcome mapping (contracts/README.md):
 *   200/201 → ok ·  409 → duplicate (idempotent success) ·  5xx / timeout →
 *   transient (retry) ·  400/422 (and other 4xx) → permanent (dead-letter) ·
 *   network/DNS/refused/timeout-before-response → no_connection.
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
import type { SaleSyncClient, SaleSyncResult } from './sale-sync-client-types.js';

const SALES_PATH = '/api/pos/v1/sales';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CURRENCY_CODE = 'EGP';

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

function exponentFor(currencyCode: string): number {
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
  /** ISO-4217 currency for the store (v1 single-currency). Defaults to EGP. */
  currencyCode?: string;
  /** Override the request timeout in tests. */
  timeoutMs?: number;
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
  };
}

/** Map an HTTP status onto the engine's outcome union (contracts/README.md). */
export function classifyStatus(status: number): SaleSyncResult {
  if (status === 200 || status === 201) return { kind: 'ok' };
  if (status === 409) return { kind: 'duplicate' };
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
  if (status === 429) return { kind: 'transient' };
  // Other 4xx (400/404/422/…) is a genuine validation/contract defect — the
  // request will not succeed on retry without intervention; dead-letter it.
  if (status >= 400) return { kind: 'permanent' };
  // Unexpected 2xx/3xx — treat as transient (don't lose the sale).
  return { kind: 'transient' };
}

export function createSaleSyncClient(deps: CreateSaleSyncClientDeps): SaleSyncClient {
  const { fetch: fetchImpl, baseUrl, getOperatorToken } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const currencyCode = deps.currencyCode ?? DEFAULT_CURRENCY_CODE;
  const root = baseUrl.replace(/\/$/, '');

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

      let response: Response;
      try {
        response = await fetchImpl(`${root}${SALES_PATH}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 016 (D5): `operatorAuthorization` = opaque bearer envelope. 016 (D7):
            // X-Device-Attestation is RETIRED from the sale wire (#559) — the
            // device token reverts to device-scope (read-down Bearer + sign-in
            // attestation body); it no longer co-travels on the sale POST.
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': payload.externalId,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Transport fault (DNS / TLS / refused / timeout) — retryable.
        return { kind: 'no_connection' };
      }

      // Body is intentionally not read: outcome is derived from status only, and
      // the raw response body is never surfaced (P7).
      return classifyStatus(response.status);
    },
  };
}
