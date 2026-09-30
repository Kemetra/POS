// VENDORED CONTRACT TYPE — DO NOT EDIT BY HAND.
//
// Source of truth: Backend-Core (ex Data-Pulse-2) `packages/contracts/openapi/pos-sales/sales.yaml`
//   Backend-Core main: a8e9ab0 (RT-77)
//   sales.yaml @ ref : b2debb4255f07ea3d6a8b582ae32c3adbe263d1a  (RT-76 `tenders` / `SaleTender`)
//   base (pre-RT-76) : 88c8d3dd851c7a3c0c94569e97a015c818af161a  (feat(032) #570)
//   generated with   : openapi-typescript 7.13.0  (already a POS devDep)
//   RT-79: `tenders` / `SaleTender` slice added by hand from the RT-76 schema (additive;
//   the rest of the slice is unchanged from the base ref).
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

/** Exact-decimal monetary amount as a string (gate A.6 — never a float). */
type DecimalAmount = string;
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
  posTotal: DecimalAmount;
  /** Format: date-time (RFC3339). */
  occurredAt: string;
  /** Format: date-time (RFC3339). OPTIONAL POS-reported clock. */
  sourceClockAt?: string;
  lines: ContractCaptureSaleLine[];
  /**
   * OPTIONAL (RT-10 D1). minItems 1; net of change; at most one per method; must sum
   * to `posTotal` (else 422 `sale_tender_mismatch`). Accepted from RT-77.
   */
  tenders?: ContractSaleTender[];
}

/** The binding `SaleTender` (`additionalProperties: false`). */
export interface ContractSaleTender {
  /** RT-10 D2 pilot methods. Vouchers are excluded. */
  method: 'cash' | 'card_external';
  /** NonNegativeDecimalAmount. */
  amount: DecimalAmount;
  /** OPTIONAL, `card_external` only: `^[A-Z0-9]{1,6}$`. POS omits it (RT-79 D-A). */
  reference?: string;
}

/** The binding `CaptureSaleLine` wire shape (`additionalProperties: false`). */
export interface ContractCaptureSaleLine {
  lineName: string;
  unitPrice: DecimalAmount;
  currencyCode: CurrencyCode;
  /** Line quantity as an exact-decimal string (no float). */
  quantity: string;
  lineAmount: DecimalAmount;
  taxAmount?: DecimalAmount;
  unit: string;
  /** Format: uuid. Optional lineage to a tenant product (FR-003). */
  tenantProductRef?: string;
}
