/**
 * RT-541 (RT-534 S5) — `sales.list`: this device's sales over a range of store
 * business days, newest first, in keyset pages.
 *
 *   • Days: `from_day` / `to_day` are Africa/Cairo business days, both
 *     inclusive. They become a `finalized_at` window through the RT-550 module
 *     (`businessDayBounds`), and each row's day is `businessDayOf(finalized_at)`.
 *     The stored `local_calendar_day` (UTC on older rows) is never read.
 *   • OD-534-4: at most 31 days; a wider range is refused, never truncated.
 *     50 rows per page by default, 1-100 allowed.
 *   • Scope: tenant / branch / terminal from the session, and for a cashier the
 *     RT-546 own-sales filter (`ownerFilter`). The request can name none of
 *     them: an unknown key is refused.
 *   • The cursor is opaque to the renderer and parsed strictly here. It only
 *     moves the position inside the window and the scope.
 *
 * The caller (sales-bridge) runs the forbidden-key scan and the RT-546
 * `admitSession` gate first.
 */

import {
  BusinessDayError,
  type BusinessDayBounds,
  type BusinessDayRange,
  businessDayBounds,
  businessDayOf,
  businessDaySpan,
  isBusinessDay,
} from '../../shared/time/business-day.js';
import {
  SALES_LIST_DEFAULT_PAGE_SIZE,
  SALES_LIST_MAX_PAGE_SIZE,
  SALES_LIST_MAX_SPAN_DAYS,
  type SaleId,
  type SaleNumber,
} from '../../shared/sales/types.js';
import type { SaleListItem, SalesListResponse } from '../../shared/bridge-api.js';
import type {
  SaleListCursor,
  SaleListRow,
  SalesRepository,
  TenantScope,
} from './repositories/sales.repository.js';

const ALLOWED_KEYS: ReadonlySet<string> = new Set(['from_day', 'to_day', 'page_size', 'cursor']);

/** `Date#toISOString` exactly: the format every `finalized_at` is written in. */
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_SALE_ID = /^[\w-]{1,64}$/;
const CURSOR_SEPARATOR = '|';
/** An instant (24) + separator + the longest id (64), rounded up. */
const CURSOR_MAX_LENGTH = 100;

/** The validated request: the window, the page size and the position. */
interface ListPlan {
  start_inclusive: string;
  end_exclusive: string;
  page_size: number;
  after: SaleListCursor | null;
}

type PlanResult = { ok: true; plan: ListPlan } | { ok: false; refusal: SalesListResponse };

const refuse = (reason: 'invalid_request' | 'range_too_wide'): PlanResult => ({
  ok: false,
  refusal: { kind: 'refused', reason },
});

function encodeCursor(row: SaleListRow): string {
  return `${row.finalized_at}${CURSOR_SEPARATOR}${row.sale_id}`;
}

/** The cursor position, null for page one, or undefined when malformed. */
function decodeCursor(value: unknown): SaleListCursor | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH) return undefined;
  const at = value.indexOf(CURSOR_SEPARATOR);
  if (at < 0) return undefined;
  const finalized_at = value.slice(0, at);
  const sale_id = value.slice(at + 1);
  if (!CURSOR_INSTANT.test(finalized_at) || !CURSOR_SALE_ID.test(sale_id)) return undefined;
  return { finalized_at, sale_id };
}

/** The page size, or undefined when it is not a whole number in 1-100. */
function decodePageSize(value: unknown): number | undefined {
  if (value === undefined) return SALES_LIST_DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= SALES_LIST_MAX_PAGE_SIZE ? value : undefined;
}

function hasOnlyAllowedKeys(req: Record<string, unknown>): boolean {
  return Object.keys(req).every((key) => ALLOWED_KEYS.has(key));
}

/** The requested day range, or null when a key or either day is malformed. */
function decodeRange(req: Record<string, unknown>): BusinessDayRange | null {
  if (!hasOnlyAllowedKeys(req)) return null;
  const { from_day: from, to_day: to } = req;
  return isBusinessDay(from) && isBusinessDay(to) ? { from, to } : null;
}

/** The `finalized_at` window of a range, or null for a day out of range. */
function boundsOf(range: BusinessDayRange): BusinessDayBounds | null {
  try {
    return businessDayBounds(range);
  } catch (error) {
    if (error instanceof BusinessDayError) return null;
    throw error;
  }
}

/** The page size and position, or null when either is malformed. */
function decodePage(req: Record<string, unknown>): Pick<ListPlan, 'page_size' | 'after'> | null {
  const page_size = decodePageSize(req.page_size);
  const after = decodeCursor(req.cursor);
  if (page_size === undefined || after === undefined) return null;
  return { page_size, after };
}

/** Validates the whole request; every malformed input is a closed refusal. */
export function planSalesList(req: Record<string, unknown>): PlanResult {
  const range = decodeRange(req);
  if (range === null) return refuse('invalid_request');
  const span = businessDaySpan(range);
  if (span < 1) return refuse('invalid_request');
  if (span > SALES_LIST_MAX_SPAN_DAYS) return refuse('range_too_wide');
  const page = decodePage(req);
  const bounds = boundsOf(range);
  if (page === null || bounds === null) return refuse('invalid_request');
  const { startInclusive: start_inclusive, endExclusive: end_exclusive } = bounds;
  return { ok: true, plan: { start_inclusive, end_exclusive, ...page } };
}

/**
 * The business day of a stored instant, or null when it cannot be read. Every
 * writer uses `Date#toISOString`, so null is defence in depth: one bad row
 * must not fail the page or send an exception across IPC.
 */
function businessDayOrNull(finalizedAt: string): string | null {
  try {
    return businessDayOf(finalizedAt);
  } catch (error) {
    if (error instanceof BusinessDayError) return null;
    throw error;
  }
}

/** One local row as the bridge shows it (shared with the RT-542 unsent-sales list). */
export function toListItem(row: SaleListRow): SaleListItem {
  return {
    sale_id: row.sale_id as SaleId,
    sale_number: row.sale_number as SaleNumber,
    business_day: businessDayOrNull(row.finalized_at),
    finalized_at: row.finalized_at,
    terminal_label: row.terminal_label,
    selling_operator_display_name: row.selling_operator_display_name,
    subtotal_minor: row.subtotal_minor,
    total_tax_minor: row.total_tax_minor,
  };
}

/**
 * Runs a validated plan in the session's scope. Reads one row past the page
 * to know whether another page exists, so a full last page ends the walk.
 */
export function runSalesList(
  salesRepo: Pick<SalesRepository, 'listByFinalizedRange'>,
  scope: TenantScope,
  sellingOperatorId: string | null,
  plan: ListPlan,
): SalesListResponse {
  const rows = salesRepo.listByFinalizedRange({
    scope,
    selling_operator_id: sellingOperatorId,
    start_inclusive: plan.start_inclusive,
    end_exclusive: plan.end_exclusive,
    after: plan.after,
    limit: plan.page_size + 1,
  });
  const page = rows.slice(0, plan.page_size);
  const last = page.at(-1);
  const hasMore = rows.length > plan.page_size && last !== undefined;
  return {
    kind: 'ok',
    sales: page.map(toListItem),
    next_cursor: hasMore ? encodeCursor(last) : null,
    coverage: 'this_device_only',
  };
}
