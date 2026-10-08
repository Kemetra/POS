// VENDORED CONTRACT TYPES — DO NOT EDIT BY HAND.
//
// Source of truth: Backend-Core `packages/contracts/openapi/pos-sales/sales.yaml`
//   version          : 1.4.0-draft
//   Backend-Core main: 95abc3efcf9dd2185fb49eaa5262d7325eab3652 (RT-175, #691)
//   sales.yaml blob  : 4e5b09c7496a44932f57a97f350726c8437eaf3c
//                      (last changed by 780bc58, RT-181 #690)
//   generated with   : openapi-typescript 7.13.0 (already a POS devDep)
//   refreshed        : 2026-10-04 (RT-15 S2) — `npx openapi-typescript <sales.yaml>`;
//                      the members below match the generated `components["schemas"]`
//                      field-for-field (names, optionality, enums, nullability).
//
// The return-flow slice of the contract: `RecordReturnRequest`,
// `ReturnLineRequest`, `RefundTender` (the request the till sends), `Sale`,
// `SaleLine`, `SaleTender` (the `readSale` answer), `SaleReturn`, `ReturnLine`
// (the `recordReturn` answer) and the canonical `Error` envelope. Pinned the
// same way as `src/main/sales-sync/__tests__/__contract__/capture-sale-request.contract.ts`:
// test-scoped, outside the `src/shared/api-types.ts` codegen snapshot (whose
// platform baseline pre-dates pos-sales; re-pinning it is a separate, gated
// slice), so `codegen:verify` is unaffected.
//
// To refresh: re-run `npx openapi-typescript <sales.yaml> -o -` against the
// current Backend-Core origin/main and replace the block below + the SHAs above.

/** Exact-decimal monetary amount as a string (`^-?[0-9]{1,15}(\.[0-9]{1,4})?$`). */
type DecimalAmount = string;
/** Non-negative exact-decimal amount (`^[0-9]{1,15}(\.[0-9]{1,4})?$`). */
type NonNegativeDecimalAmount = string;
/** ISO-4217 alphabetic code (`^[A-Z]{3}$`). */
type CurrencyCode = string;

/** `RecordReturnRequest` (`additionalProperties: false`). */
export interface ContractRecordReturnRequest {
  sourceSystem: string;
  externalId: string;
  lines: ContractReturnLineRequest[];
  refundTenders: ContractRefundTender[];
  reason?: string;
}

/** `ReturnLineRequest` (`additionalProperties: false`). */
export interface ContractReturnLineRequest {
  /** Format: uuid */
  lineRef: string;
  /** `^[0-9]{1,13}(\.[0-9]{1,6})?$`, > 0, whole on a whole-quantity line. */
  quantity: string;
}

/** `RefundTender` (`additionalProperties: false`). Cash only (RT-14 D3). */
export interface ContractRefundTender {
  method: 'cash';
  amount: NonNegativeDecimalAmount;
}

/** `SaleTender` (`additionalProperties: false`). */
export interface ContractSaleTender {
  method: 'cash' | 'card_external';
  amount: NonNegativeDecimalAmount;
  reference?: string;
}

/** `Sale` (`additionalProperties: false`) — the `readSale` / `captureSale` answer. */
export interface ContractSale {
  /** Format: uuid */
  saleRef: string;
  /** Format: uuid */
  storeId: string;
  currencyCode: CurrencyCode;
  posTotal: DecimalAmount;
  /** Format: date-time */
  occurredAt: string;
  /** Format: date-time */
  receivedAt: string;
  /** Format: date */
  businessDate: string;
  /** Format: date-time */
  processedAt?: string | null;
  /** Format: date-time */
  sourceClockAt?: string | null;
  sourceSystem: string;
  externalId: string;
  mismatchFlag: boolean;
  syncStatus: 'captured' | 'synced' | 'failed-retryable' | 'failed-needs-repair';
  voided: boolean;
  tenders?: ContractSaleTender[];
  lines: ContractSaleLine[];
}

/** `SaleLine` (`additionalProperties: false`). */
export interface ContractSaleLine {
  /** Format: uuid */
  lineRef: string;
  lineName: string;
  unitPrice: DecimalAmount;
  currencyCode: CurrencyCode;
  quantity: string;
  lineAmount: DecimalAmount;
  taxAmount?: DecimalAmount | null;
  unit: string;
  tenantProductRef?: string | null;
  returnedQuantity: string;
  returnableQuantity: string;
}

/** `SaleReturn` (`additionalProperties: false`) — the `recordReturn` answer. */
export interface ContractSaleReturn {
  /** Format: uuid */
  returnRef: string;
  /** Format: uuid */
  saleRef: string;
  /** Format: date-time */
  recordedAt: string;
  /** Format: date */
  businessDate: string;
  sourceSystem: string;
  externalId: string;
  currencyCode: CurrencyCode;
  returnTotal: DecimalAmount;
  lines: ContractReturnLine[];
  refundTenders: ContractRefundTender[];
  reason: string | null;
}

/** `ReturnLine` (`additionalProperties: false`). */
export interface ContractReturnLine {
  /** Format: uuid */
  lineRef: string;
  quantity: string;
  lineAmount: DecimalAmount;
  taxAmount: DecimalAmount | null;
  returnedQuantity: string;
  returnableQuantity: string;
}

/** The canonical `Error` envelope. */
export interface ContractError {
  error: {
    code: string;
    message: string;
    /** Format: uuid */
    request_id?: string;
  };
}
