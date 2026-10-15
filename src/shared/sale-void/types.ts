/**
 * RT-530 — the sale-void bridge contract (`window.api.saleVoid`).
 *
 * A finalized sale is voided only with a bound RT-114 manager approval from a
 * different, store_manager-or-above person (never the requester, never the
 * sale's selling operator), on the sale's own business day (owner decisions,
 * Jira RT-530 comment 11988). The renderer asks main for an approval of the
 * exact sale (`approval.request`, action `sale.void`, subject = the local
 * `sale_id`), then spends the opaque `approval_id` here. Main binds it into a
 * durable journal row in one transaction and sends it later, under the
 * REQUESTER's own operator envelope only, when the sale has synced and that
 * operator is signed in online.
 *
 * The bridge carries totals, ids and closed codes only: no approver identity,
 * no `users.id`, no envelope, no PIN.
 */

export const SALE_VOID_IPC_CHANNELS = {
  LOOKUP: 'sale-void:lookup',
  REQUEST: 'sale-void:request',
  LIST: 'sale-void:list',
  ACKNOWLEDGE: 'sale-void:acknowledge',
} as const;

/** The journal states (migration 0054). `refused` and `confirmed` are final. */
export const SALE_VOID_STATES = ['pending', 'unknown', 'confirmed', 'refused'] as const;
export type SaleVoidState = (typeof SALE_VOID_STATES)[number];

/**
 * Why a void was refused BY BACKEND-CORE (the closed set of the contract's
 * `void_*` codes plus the generic statuses). Terminal: the void is not
 * retried.
 */
export const SERVER_VOID_REFUSALS = [
  'void_approval_required',
  'void_approval_invalid',
  'void_outside_business_day',
  'void_requester_mismatch',
  'void_requester_not_eligible',
  'void_self_approval',
  'void_approver_not_eligible',
  'already_reversed',
  'sale_not_found',
  'conflict',
  'validation_error',
] as const;
export type ServerVoidRefusal = (typeof SERVER_VOID_REFUSALS)[number];

/** Why main refused to take a void request or a lookup (nothing journaled). */
export const LOCAL_VOID_REFUSALS = [
  'feature_disabled',
  'no_session',
  'session_locked',
  'invalid_input',
  /** No sale of this terminal has that number. */
  'sale_not_found',
  /** The sale's business day has passed: use a return. */
  'not_same_day',
  /** The sale already has a live void (requested, sent or confirmed). */
  'already_voided',
  /** The sale has a return (any state but a refused one). */
  'has_return',
  /** This session holds no operator envelope, so it could never send the void. */
  'no_operator_envelope',
  /** The approval did not hold (used, expired, another sale, or the sale changed). */
  'approval_invalid',
  'approval_stale',
  'void_unavailable',
] as const;
export type LocalVoidRefusal = (typeof LOCAL_VOID_REFUSALS)[number];

export type SaleVoidRefusalReason = ServerVoidRefusal | LocalVoidRefusal;

export interface SaleVoidRefused {
  kind: 'refused';
  reason: LocalVoidRefusal;
}

/** What a queued void is waiting for (derived live; never stored). */
export const SALE_VOID_WAITING_FOR = [
  /** The sale has not synced to Backend-Core yet, so it has no server reference. */
  'sale_sync',
  /** Only the requester's own envelope may send it: they are not signed in online. */
  'requester_sign_in',
] as const;
export type SaleVoidWaitingFor = (typeof SALE_VOID_WAITING_FOR)[number];

export interface SaleVoidLookupRequest {
  /** The local sale number printed on the receipt (`<terminal>-<day>-<seq>`). */
  sale_number: string;
}

/** The sale found by number, and whether (and why not) it can be voided now. */
export interface SaleVoidSaleView {
  sale_id: string;
  sale_number: string;
  finalized_at: string;
  total_minor: number;
  /** Net cash taken in this sale (what a void takes back out of the drawer). */
  cash_minor: number;
  selling_operator_display_name: string;
  /** Null when the sale can be voided now. */
  ineligible: Extract<LocalVoidRefusal, 'not_same_day' | 'already_voided' | 'has_return'> | null;
}

export type SaleVoidLookupResponse = { kind: 'sale'; sale: SaleVoidSaleView } | SaleVoidRefused;

export interface SaleVoidRequest {
  sale_id: string;
  /** The opaque single-use `approval_id` from `approval.request` (action `sale.void`). */
  approval_id: string;
}

export type SaleVoidRequestResponse =
  | { kind: 'requested'; void: SaleVoidJournalView }
  | SaleVoidRefused;

export interface SaleVoidAcknowledgeRequest {
  void_id: string;
}

export type SaleVoidAcknowledgeResponse = { kind: 'acknowledged' } | SaleVoidRefused;

/** One journal row as the renderer sees it. */
export interface SaleVoidJournalView {
  void_id: string;
  sale_number: string;
  total_minor: number;
  requested_at: string;
  state: SaleVoidState;
  /** Display name of the operator who requested it (the only one who can send it). */
  requester_display_name: string;
  /** Set only on a `pending` / `unknown` row that cannot be sent right now. */
  waiting_for: SaleVoidWaitingFor | null;
  /** Set only on a `refused` row. */
  refusal_reason: ServerVoidRefusal | null;
  /** A refused row staff have not acknowledged yet (drives the banner). */
  needs_attention: boolean;
  confirmed_at: string | null;
}

export interface SaleVoidListView {
  kind: 'list';
  voids: SaleVoidJournalView[];
}

export type SaleVoidListResponse = SaleVoidListView | SaleVoidRefused;

export interface SaleVoidBridgeAPI {
  lookup(req: SaleVoidLookupRequest): Promise<SaleVoidLookupResponse>;
  request(req: SaleVoidRequest): Promise<SaleVoidRequestResponse>;
  list(): Promise<SaleVoidListResponse>;
  acknowledge(req: SaleVoidAcknowledgeRequest): Promise<SaleVoidAcknowledgeResponse>;
}
