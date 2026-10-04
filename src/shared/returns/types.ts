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
 * RT-15 S4 — how a confirmed return's cash left the till: `drawer` (the
 * drawer kick reported opened) or `manual` (the operator opened the drawer by
 * hand and attested the payout).
 */
export const RETURN_PAYOUT_METHODS = ['drawer', 'manual'] as const;
export type ReturnPayoutMethod = (typeof RETURN_PAYOUT_METHODS)[number];

/**
 * RT-15 S4 — why the drawer did not open for a payout: the sale drawer's own
 * failure reasons (no drawer configured, the printer's drawer port failed, an
 * OS fault), plus `timeout` when the drawer did not answer in time.
 */
export const RETURN_DRAWER_FAILURES = [
  'no_drawer_configured',
  'printer_dk_failure',
  'os_error',
  'timeout',
] as const;
export type ReturnDrawerFailure = (typeof RETURN_DRAWER_FAILURES)[number];

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
  // RT-15 S4 — payout and slip.
  // No return with this id on this terminal.
  'return_not_found',
  // The return is not confirmed by Backend-Core (pending, unknown or refused).
  'not_payable',
  // The cash of this return was already paid out.
  'already_paid_out',
  // A payout of this return was started earlier and not completed: it must be
  // completed (drawer again, or a manual payout), never started afresh.
  'payout_started',
  // Completing a payout that was never started.
  'payout_not_started',
  // A slip exists only for a paid-out return.
  'not_paid_out',
  // The app is quitting; nothing was done (not audited).
  'shutting_down',
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

/** RT-15 S4 — the payout of a confirmed return, once one was started. */
export interface ReturnPayoutView {
  readonly startedAt: string;
  /** Null while the payout is started but not completed (e.g. the drawer failed). */
  readonly paidAt: string | null;
  readonly method: ReturnPayoutMethod | null;
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
  /** RT-15 S4: null until a payout of this return is started. */
  readonly payout: ReturnPayoutView | null;
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

/**
 * RT-15 S4 — what the operator asks of a confirmed return's payout:
 *   • `start`        claim the payout, open the drawer, record it once it opened;
 *   • `retry_drawer` a started payout: open the drawer again, record it once it opened;
 *   • `manual`       a started payout: the operator paid from a drawer opened by
 *                    hand and attests it; recorded without a kick.
 * The amount is never part of the request: main pays the server-confirmed total.
 */
export const RETURN_PAYOUT_ACTIONS = ['start', 'retry_drawer', 'manual'] as const;
export type ReturnPayoutAction = (typeof RETURN_PAYOUT_ACTIONS)[number];

export interface ReturnsPayoutRequest {
  readonly returnId: string;
  readonly action: ReturnPayoutAction;
}

export interface ReturnsReprintRequest {
  readonly returnId: string;
}

export type ReturnSlipStatus = 'printed' | 'failed';

/**
 * `paid_out`: the payout is recorded (once); `slip` says whether the slip
 * printed. `drawer_failed`: the drawer did not open and NOTHING was recorded;
 * the payout stays started. `refused`: nothing was done (`ret` is the return
 * as it now stands, when it may be shown).
 */
export type ReturnsPayoutResponse =
  | {
      readonly kind: 'paid_out';
      readonly ret: ReturnJournalView;
      readonly method: ReturnPayoutMethod;
      readonly slip: ReturnSlipStatus;
    }
  | {
      readonly kind: 'drawer_failed';
      readonly ret: ReturnJournalView;
      readonly reason: ReturnDrawerFailure;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ReturnsRefusalReason;
      readonly ret: ReturnJournalView | null;
    };

export type ReturnsReprintResponse =
  | { readonly kind: 'printed' }
  | { readonly kind: 'print_failed' }
  | ReturnsRefused;

/** The typed `returns.*` preload namespace. Every call is gated in main. */
export interface ReturnsBridgeAPI {
  lookup(req: ReturnsLookupRequest): Promise<ReturnsLookupResponse>;
  quote(req: ReturnsQuoteRequest): Promise<ReturnsQuoteResponse>;
  submit(req: ReturnsSubmitRequest): Promise<ReturnsSubmitResponse>;
  resolve(): Promise<ReturnsResolveResponse>;
  list(): Promise<ReturnsListResponse>;
  /** RT-15 S4: pay out a confirmed return's cash (drawer, then slip). */
  payout(req: ReturnsPayoutRequest): Promise<ReturnsPayoutResponse>;
  /** RT-15 S4: print a paid-out return's slip again, marked as a copy. */
  reprintSlip(req: ReturnsReprintRequest): Promise<ReturnsReprintResponse>;
}
