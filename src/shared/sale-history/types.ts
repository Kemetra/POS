/**
 * RT-542 (RT-534 S6) — the `saleHistory.*` bridge: the store-wide sales history,
 * sale detail and reprint, read through Backend-Core (`sale-history.yaml`,
 * RT-537 contract, RT-539 runtime).
 *
 * Owner decisions (RT-534 comment 12048, Confluence 40468506):
 *   • OD-534-1 = A — a cashier sees ONLY their own sales, from every terminal of
 *     the store; a manager or admin sees every sale of the store. Enforced by
 *     Backend-Core AND in the Electron main process (never by the renderer).
 *   • OD-534-2 = A — a cashier reprints only their own sales.
 *   • OD-534-4 — at most 31 inclusive business days; 50 rows per page, 1-100.
 *   • OD-534-8 — a voided sale gets only a VOIDED sale-record slip; a returned
 *     sale's slip is marked and shows its returns.
 *
 * Money crosses the bridge as integer minor units only. Tenant, store,
 * terminal, the operator and every credential come from the main process; the
 * renderer names none of them.
 */

import type { SaleListItem } from '../bridge-api.js';
import type { SaleId } from '../sales/types.js';

export const SALE_HISTORY_IPC_CHANNELS = {
  LIST: 'saleHistory:list',
  READ: 'saleHistory:read',
  REPRINT: 'saleHistory:reprint',
} as const;

export type SaleHistoryIpcChannel =
  (typeof SALE_HISTORY_IPC_CHANNELS)[keyof typeof SALE_HISTORY_IPC_CHANNELS];

/** The closed refusal vocabulary of `saleHistory.*` (generic copy per reason). */
export const SALE_HISTORY_REFUSAL_REASONS = [
  'no_session',
  'role_denied',
  'forbidden_field_in_request',
  'invalid_request',
  'range_too_wide',
  /** Not visible to this operator, or absent: never says which (non-disclosing). */
  'sale_not_found',
  /** Backend-Core refused the credential (401 / 403). */
  'server_refused',
  /** Backend-Core cannot be reached or answered unreadably (detail / reprint). */
  'unavailable',
  /** The next page could not be fetched; the pages already shown stay valid. */
  'continuation_failed',
  /** Backend-Core rejected the cursor; the walk restarts from page one. */
  'cursor_rejected',
  /** The operator or the session changed while the request ran. */
  'session_changed',
  /** A true duplicate is not allowed (incomplete facts or voided, OD-534-3/8). */
  'duplicate_unavailable',
  /** This terminal has no successful original print of the sale (OD-534-2). */
  'not_yet_printed',
  'printer_unavailable',
  /** A reprint of this sale is already running. */
  'busy',
] as const;

export type SaleHistoryRefusalReason = (typeof SALE_HISTORY_REFUSAL_REASONS)[number];

export type SaleHistoryRefused = { kind: 'refused'; reason: SaleHistoryRefusalReason };

/** Where a shown name comes from (OD-534-6): never a current value passed off as historical. */
export type SaleHistoryNameSource = 'snapshot' | 'current' | 'unavailable';

/** Read-only operational ERP posting state (OD-534-5). Never a fiscal claim. */
export type SaleHistoryErpState = 'posted' | 'pending' | 'failed' | 'unknown';

export type SaleHistorySyncStatus =
  | 'captured'
  | 'synced'
  | 'failed-retryable'
  | 'failed-needs-repair';

export type SaleHistoryReprintMark = 'voided' | 'returned';

export type SaleHistoryReprintKind = 'duplicate' | 'sale_record';

/** One sale the server has received. */
export interface SaleHistoryRow {
  sale_ref: string;
  /** Null when the sale was captured without a receipt snapshot. */
  sale_number: string | null;
  /** `YYYY-MM-DD` in the store timezone, as the server persisted it. */
  business_day: string;
  occurred_at: string;
  received_at: string;
  device_label: string | null;
  device_label_source: SaleHistoryNameSource;
  operator_display_name: string | null;
  operator_name_source: SaleHistoryNameSource;
  total_minor: number;
  sync_status: SaleHistorySyncStatus;
  voided: boolean;
  return_state: 'none' | 'partial' | 'full';
  erp_state: SaleHistoryErpState;
  /** This terminal's own record of the sale, when it made it (receipt fidelity). */
  local_sale_id: SaleId | null;
}

/** One sale of THIS terminal the server has not received yet. */
export interface SaleHistoryUnsyncedRow {
  sale_id: SaleId;
  sale_number: string;
  business_day: string | null;
  finalized_at: string;
  terminal_label: string;
  selling_operator_display_name: string;
  subtotal_minor: number;
  total_tax_minor: number;
  /** `not_started`: no send attempted yet; `dead_letter`: the server refused it. */
  sync: 'not_started' | 'pending' | 'dead_letter';
}

export interface SaleHistoryListRequest {
  /** First business day, `YYYY-MM-DD`, inclusive. */
  from_day: string;
  /** Last business day, `YYYY-MM-DD`, inclusive; at most 31 days. */
  to_day: string;
  /** 1-100; 50 when absent. */
  page_size?: number;
  /** `next_cursor` of the previous page; absent or null for page one. */
  cursor?: string | null;
}

/** Online: the sales the server had received by `as_of`, never "the complete store". */
export interface SaleHistoryServerPage {
  kind: 'ok';
  source: 'server';
  rows: SaleHistoryRow[];
  next_cursor: string | null;
  as_of: string;
  /** IANA zone of the store's business days (RT-553 will compare it). */
  store_timezone: string;
  visibility: 'store' | 'own_sales';
  from_day: string;
  to_day: string;
  /** This terminal's unsent sales in the range, on page one only. */
  unsynced: SaleHistoryUnsyncedRow[];
  /** True when more unsent sales exist than `unsynced` shows. */
  unsynced_truncated: boolean;
}

/** Offline: this device's sales only (the RT-541 local read). */
export interface SaleHistoryLocalPage {
  kind: 'ok';
  source: 'local';
  coverage: 'this_device_only';
  /** Why the server was not used. */
  offline_reason: 'no_connection' | 'no_credential' | 'server_unavailable';
  rows: SaleListItem[];
  next_cursor: string | null;
}

export type SaleHistoryListResponse =
  | SaleHistoryServerPage
  | SaleHistoryLocalPage
  | SaleHistoryRefused;

export interface SaleHistoryReadRequest {
  sale_ref: string;
}

export interface SaleHistoryLine {
  line_ref: string;
  /** 1-based position on the original receipt; null when not recorded. */
  sequence: number | null;
  name: string;
  unit_price_minor: number;
  /** The recorded quantity, as an exact decimal string. */
  quantity: string;
  line_minor: number;
  tax_minor: number | null;
  unit: string;
  returned_quantity: string;
}

export interface SaleHistoryTender {
  method: 'cash' | 'card_external';
  /** Net of change, as captured. */
  amount_minor: number;
  reference: string | null;
  sequence: number | null;
}

export interface SaleHistoryReturn {
  return_ref: string;
  recorded_at: string;
  business_day: string;
  total_minor: number;
  lines: { line_ref: string; quantity: string; line_minor: number }[];
}

export interface SaleHistoryDetail {
  summary: SaleHistoryRow;
  lines: SaleHistoryLine[];
  line_order: 'recorded' | 'not_recorded';
  tender_state: 'recorded' | 'unknown';
  tenders: SaleHistoryTender[];
  /** Null when not recorded. */
  change_minor: number | null;
  settled_at: string | null;
  receipt_number: string | null;
  receipt_header: {
    branch_name: string;
    branch_address: string;
    tax_registration_id: string;
  } | null;
  void: {
    voided_at: string;
    void_business_day: string | null;
    approved: boolean;
    approver_role: 'owner' | 'tenant_admin' | 'store_manager' | null;
  } | null;
  returns: SaleHistoryReturn[];
  erp: {
    sale: SaleHistoryErpState;
    sale_document_ref: string | null;
    reversal: SaleHistoryErpState | null;
    reversal_document_ref: string | null;
  };
  receipt_facts: 'complete' | 'partial';
  reprint: {
    duplicate: 'allowed' | 'unavailable_incomplete' | 'unavailable_voided';
    marks: SaleHistoryReprintMark[];
  };
}

export type SaleHistoryReadResponse =
  | { kind: 'ok'; detail: SaleHistoryDetail }
  | SaleHistoryRefused;

export interface SaleHistoryReprintRequest {
  sale_ref: string;
  kind: SaleHistoryReprintKind;
}

export type SaleHistoryReprintResponse =
  | {
      kind: 'ok';
      printed: SaleHistoryReprintKind;
      /** The server-assigned copy number that was printed. */
      copy_number: number;
      marks: SaleHistoryReprintMark[];
      printed_at: string;
    }
  | SaleHistoryRefused;

/**
 * Every handler runs the main-process gate first (session, lock, the RT-546
 * role allowlist); scope and credential never come from the renderer.
 */
export interface SaleHistoryBridgeAPI {
  list(req: SaleHistoryListRequest): Promise<SaleHistoryListResponse>;
  read(req: SaleHistoryReadRequest): Promise<SaleHistoryReadResponse>;
  reprint(req: SaleHistoryReprintRequest): Promise<SaleHistoryReprintResponse>;
}
