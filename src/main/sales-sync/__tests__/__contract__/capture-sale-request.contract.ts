// VENDORED CONTRACT TYPE — DO NOT EDIT BY HAND.
//
// Source of truth: Backend-Core (ex Data-Pulse-2) `packages/contracts/openapi/pos-sales/sales.yaml`
//   version          : 1.6.0-draft
//   Backend-Core main: 352b86ad3862452eb7300bf9e13d81dd771266bf (RT-225, #710)
//   sales.yaml blob  : acb4e5b0c894fd03b232e99daf236501cf491867
//                      (= contracts/backend-core/openapi/pos-sales/sales.yaml, PIN)
//   generated with   : openapi-typescript 7.13.0  (already a POS devDep)
//   refreshed        : 2026-10-06 (RT-225 step 2) — `npx openapi-typescript
//                      contracts/backend-core/openapi/pos-sales/sales.yaml`; the
//                      `CaptureSaleRequest` / `CaptureSaleLine` / `SaleTender` members below
//                      match the generated `components["schemas"]` field-for-field
//                      (names, optionality, enum, money alias). 1.5.0-draft added the
//                      optional `operatorUserId` (device scheme); 1.6.0-draft adds only the
//                      optional `admissionCheckAt` (device scheme only).
//
// This is the `CaptureSaleRequest` / `CaptureSaleLine` slice of the binding DP-2
// contract, generated from the SHARED `sales.yaml` that BOTH sides realize (the
// POS `createSaleSyncClient` docstring and the DP-2 `CaptureSaleRequestSchema`
// DTO both cite this file). It is deliberately NOT pulled through POS's
// `scripts/codegen-api.ts` snapshot pipeline:
//   • that pipeline regenerates the whole 24k-line `src/shared/api-types.ts`
//     from a pinned platform-OpenAPI snapshot that PRE-DATES the pos-sales
//     surface — refreshing it would re-pin every endpoint (a contract-baseline
//     bump that is a separate, owner-gated slice), and
//   • `scripts/verify-codegen.ts` only checks `src/shared/api-types.ts`, so a
//     test-scoped vendored type here does NOT trip the determinism gate.
//
// Per AD-SALE-CAPTURE-1 (Option A, ratified 2026-06-19): POS conforms to DP-2's
// existing `.strict()` contract; this vendored copy is the contract-test target.
// To refresh: re-run `npx openapi-typescript <sales.yaml> -o -` against the
// current DP-2 origin/main and replace the block below + the SHAs above.

/** Exact-decimal non-negative monetary amount as a string (gate A.6 — never a float). */
type NonNegativeDecimalAmount = string;
/** ISO-4217 alphabetic currency code (FR-005). */
type CurrencyCode = string;

/**
 * The binding `CaptureSaleRequest` request body (`additionalProperties: false`).
 * `tenant_id` / `store_id` / `created_by` etc. are intentionally absent — they
 * resolve server-side and are rejected if present (FR-061/062, mass-assignment ban).
 */
export interface ContractCaptureSaleRequest {
  sourceSystem: string;
  externalId: string;
  currencyCode: CurrencyCode;
  posTotal: NonNegativeDecimalAmount;
  /** Format: date-time (RFC3339). */
  occurredAt: string;
  /** Format: date-time (RFC3339). OPTIONAL POS-reported clock. */
  sourceClockAt?: string;
  lines: ContractCaptureSaleLine[];
  /**
   * OPTIONAL (RT-10 D1) — how the sale was paid. Net of change, at most one entry per
   * method, and summing to `posTotal` exactly (else 422 `sale_tender_mismatch`).
   * Absent = a tender-unknown sale (RT-10 D8). Accepted from RT-77.
   */
  tenders?: ContractSaleTender[];
  /**
   * Format: uuid. OPTIONAL (RT-224, 1.5.0-draft): the `users.id` of the cashier who
   * made the sale. REQUIRED with the `device` scheme and MUST be absent with
   * `operatorAuthorization` (its presence selects the device path).
   */
  operatorUserId?: string;
  /**
   * Format: date-time. OPTIONAL (RT-225, 1.6.0-draft): the sale's settled time, used
   * ONLY for the cashier admission-window check in place of `occurredAt`. Allowed
   * only with `operatorUserId`; must be <= `occurredAt` and at most 7 days before it
   * (else 400). Not part of `payload_hash`, but part of the idempotency fingerprint.
   */
  admissionCheckAt?: string;
}

/** The binding `SaleTender` (`additionalProperties: false`). */
export interface ContractSaleTender {
  /** RT-10 D2 pilot methods. Vouchers are excluded from the pilot. */
  method: 'cash' | 'card_external';
  amount: NonNegativeDecimalAmount;
  /** OPTIONAL, `card_external` only (else 400). POS omits it (RT-79 D-A). */
  reference?: string;
}

/** The binding `CaptureSaleLine` wire shape (`additionalProperties: false`). */
export interface ContractCaptureSaleLine {
  lineName: string;
  unitPrice: NonNegativeDecimalAmount;
  currencyCode: CurrencyCode;
  /** Line quantity as an exact-decimal string (no float). */
  quantity: string;
  lineAmount: NonNegativeDecimalAmount;
  taxAmount?: NonNegativeDecimalAmount;
  unit: string;
  /** Format: uuid. Optional lineage to a tenant product (FR-003). */
  tenantProductRef?: string;
}
