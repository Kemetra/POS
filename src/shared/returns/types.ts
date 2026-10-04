/**
 * RT-15 S2 — shared types for the cashier return flow (`returns.*` bridge).
 *
 * Money is integer minor units only. Quantities are whole numbers (RT-15 D-e).
 * Nothing here carries the operator envelope, the Idempotency-Key, or a raw
 * server body: those stay in the main process.
 */

/** Durable state of a journaled return (migration 0039). */
export const RETURN_STATES = ['pending', 'confirmed', 'paid_out', 'refused', 'unknown'] as const;
export type ReturnState = (typeof RETURN_STATES)[number];

/**
 * Refusals Backend-Core can answer for `recordReturn` / `readSale`, each kept
 * distinct (AC10). `returns_unavailable` is the contract's non-disclosing 404:
 * the `POS_RETURNS_ENABLED` gate is off, or the sale is unknown in this scope.
 */
export const SERVER_RETURN_REFUSALS = [
  'over_return',
  'already_reversed',
  'conflict',
  'return_tender_mismatch',
  'validation_error',
  'unauthorized',
  'returns_unavailable',
] as const;
export type ServerReturnRefusal = (typeof SERVER_RETURN_REFUSALS)[number];

/** Refusals decided on the till before anything is sent. */
export const LOCAL_RETURN_REFUSALS = [
  'feature_disabled',
  'no_session',
  'role_denied',
  'invalid_input',
  'sale_not_found',
  'sale_not_synced',
  'card_tender_blocked',
  'sale_voided',
  'nothing_returnable',
  'line_not_returnable',
  'quantity_out_of_range',
  'amount_not_payable',
  'unresolved_return_exists',
  'offline',
  // Neither the till's tender summary nor the server proves the sale was paid
  // all in cash (D-c fails closed: a tender-unknown sale is not cash-refunded).
  'tender_unknown',
  // The live server sale is not the one asked for (another saleRef, mixed
  // currency, duplicate or foreign lines): fail closed, nothing exposed.
  'sale_mismatch',
  // The authorized manager/admin session ended, locked or switched while a
  // request was awaited; nothing was journaled or sent.
  'session_changed',
] as const;
export type LocalReturnRefusal = (typeof LOCAL_RETURN_REFUSALS)[number];

export type ReturnsRefusalReason = ServerReturnRefusal | LocalReturnRefusal;

export interface ReturnsRefused {
  readonly kind: 'refused';
  readonly reason: ReturnsRefusalReason;
}

/** One line the manager asks to return: a server `lineRef` and a whole quantity. */
export interface ReturnLineInput {
  readonly lineRef: string;
  readonly quantity: number;
}

export interface ReturnableLineView {
  readonly lineRef: string;
  readonly lineName: string;
  readonly soldQuantity: number;
  readonly returnedQuantity: number;
  /** Whole quantity still returnable (0 when the sale is voided). */
  readonly returnableQuantity: number;
  /** Null when the unit price is not representable in minor units. */
  readonly unitPriceMinor: number | null;
}

export interface ReturnableSaleView {
  readonly saleId: string;
  readonly saleNumber: string;
  readonly saleRef: string;
  readonly currencyCode: string;
  readonly lines: readonly ReturnableLineView[];
}

export interface ReturnQuoteLineView {
  readonly lineRef: string;
  readonly quantity: number;
  readonly amountMinor: number;
}

export interface ReturnQuoteView {
  readonly saleRef: string;
  readonly currencyCode: string;
  readonly lines: readonly ReturnQuoteLineView[];
  /** The exact refund the cash tender must equal (contract pricing rule). */
  readonly totalMinor: number;
}

export interface ReturnJournalView {
  readonly returnId: string;
  readonly saleId: string;
  readonly saleNumber: string;
  readonly state: ReturnState;
  readonly currencyCode: string;
  readonly quotedTotalMinor: number;
  /** Server `returnTotal` in minor units once confirmed; else null. */
  readonly returnTotalMinor: number | null;
  /** Server `returnRef` once confirmed; else null. */
  readonly returnRef: string | null;
  readonly refusalReason: ReturnsRefusalReason | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly lines: readonly { readonly lineRef: string; readonly quantity: number }[];
}

export interface ReturnsLookupRequest {
  readonly saleNumber: string;
}

export interface ReturnsQuoteRequest {
  readonly saleNumber: string;
  readonly lines: readonly ReturnLineInput[];
}

export type ReturnsSubmitRequest = ReturnsQuoteRequest;

export type ReturnsLookupResponse =
  | { readonly kind: 'ok'; readonly sale: ReturnableSaleView }
  | ReturnsRefused;

export type ReturnsQuoteResponse =
  | { readonly kind: 'ok'; readonly quote: ReturnQuoteView }
  | ReturnsRefused;

/**
 * `confirmed`: Backend-Core answered 201/200 (a replay counts); the refund is
 * payout-ready. `unconfirmed`: the answer was lost (timeout / network / 5xx);
 * the return stays journaled as `unknown` and is NEVER success until resolved.
 */
export type ReturnsSubmitResponse =
  | { readonly kind: 'confirmed'; readonly ret: ReturnJournalView; readonly replayed: boolean }
  | { readonly kind: 'unconfirmed'; readonly ret: ReturnJournalView }
  | {
      readonly kind: 'refused';
      readonly reason: ReturnsRefusalReason;
      /** The journaled return, when the refusal came after journaling. */
      readonly ret: ReturnJournalView | null;
    };

export type ReturnsResolveResponse =
  | {
      readonly kind: 'ok';
      readonly confirmed: number;
      readonly refused: number;
      readonly unresolved: number;
    }
  | ReturnsRefused;

export type ReturnsListResponse =
  | { readonly kind: 'ok'; readonly returns: readonly ReturnJournalView[] }
  | ReturnsRefused;

/** The typed `returns.*` preload namespace. Every call is gated in main. */
export interface ReturnsBridgeAPI {
  lookup(req: ReturnsLookupRequest): Promise<ReturnsLookupResponse>;
  quote(req: ReturnsQuoteRequest): Promise<ReturnsQuoteResponse>;
  submit(req: ReturnsSubmitRequest): Promise<ReturnsSubmitResponse>;
  resolve(): Promise<ReturnsResolveResponse>;
  list(): Promise<ReturnsListResponse>;
}
