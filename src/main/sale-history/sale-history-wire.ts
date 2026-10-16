/**
 * RT-542 — strict readers for the Backend-Core sale-history answers
 * (`sale-history.yaml`: `SaleHistoryPage`, `SaleHistoryDetail`, `SaleReprint`).
 *
 * The server is not trusted: every field is checked against the contract and
 * converted to the bridge view. Money is an exact-decimal string; it becomes
 * integer minor units only when it is exactly representable in EGP (no float
 * ever touches it, `returns-money.ts`). One field off-contract makes the whole
 * answer unreadable (null), so a partial or guessed view never reaches the
 * renderer.
 */

import type {
  SaleHistoryDetail,
  SaleHistoryErpState,
  SaleHistoryLine,
  SaleHistoryNameSource,
  SaleHistoryReprintKind,
  SaleHistoryReprintMark,
  SaleHistoryReturn,
  SaleHistoryRow,
  SaleHistorySyncStatus,
  SaleHistoryTender,
} from '../../shared/sale-history/types.js';
import { amount4ToMinor, parseAmount4 } from '../returns/returns-money.js';
import { isUuid } from '../returns/returns-wire.js';

/** The pilot currency and its minor-unit exponent. Any other currency is unreadable. */
const CURRENCY = 'EGP';
const CURRENCY_EXPONENT = 2;

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_QUANTITY = /^\d{1,13}(?:\.\d{1,6})?$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/** A parsed list page, before the main process adds the local view. */
export interface WireHistoryPage {
  rows: Omit<SaleHistoryRow, 'local_sale_id'>[];
  next_cursor: string | null;
  as_of: string;
  store_timezone: string;
  visibility: 'store' | 'own_sales';
  from_day: string;
  to_day: string;
  /** Each row's operator `userRef` (main-only: the OD-534-1 cross-check). */
  operator_refs: (string | null)[];
}

export interface WireHistoryDetail {
  detail: Omit<SaleHistoryDetail, 'summary'> & { summary: Omit<SaleHistoryRow, 'local_sale_id'> };
  operator_ref: string | null;
}

export interface WireReprint {
  reprint_ref: string;
  sale_ref: string;
  mode: 'authorize' | 'record';
  kind: SaleHistoryReprintKind;
  marks: SaleHistoryReprintMark[];
  copy_number: number;
  recorded_at: string;
}

/** Thrown inside a reader on the first off-contract field; caught at the entry. */
class OffContract extends Error {}

type Obj = Record<string, unknown>;

function fail(): never {
  throw new OffContract();
}

function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : fail();
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : fail();
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : fail();
}

function strOrNull(value: unknown): string | null {
  return value === null ? null : str(value);
}

function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : fail();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fail();
}

function uuid(value: unknown): string {
  const text = str(value);
  return isUuid(text) ? text : fail();
}

function uuidOrNull(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function instant(value: unknown): string {
  const text = str(value);
  return Number.isFinite(Date.parse(text)) ? text : fail();
}

function instantOrNull(value: unknown): string | null {
  return value === null ? null : instant(value);
}

function day(value: unknown): string {
  const text = str(value);
  return BUSINESS_DAY.test(text) ? text : fail();
}

function dayOrNull(value: unknown): string | null {
  return value === null ? null : day(value);
}

/** "2.000000" → "2", "1.500" → "1.5" (a decimal with a fraction part). */
function withoutTrailingZeros(text: string): string {
  let end = text.length;
  while (text[end - 1] === '0') end -= 1;
  if (text[end - 1] === '.') end -= 1;
  return text.slice(0, end);
}

/** An exact decimal quantity without trailing zeros: "2.000000" → "2", "1.500" → "1.5". */
function quantity(value: unknown): string {
  const text = str(value);
  if (!DECIMAL_QUANTITY.test(text)) return fail();
  return text.includes('.') ? withoutTrailingZeros(text) : text;
}

/** Control and format characters (bidi marks, zero-width, BOM) never reach a screen or slip. */
const HIDDEN = /[\p{Cc}\p{Cf}]/gu;

/** Server text as shown: hidden characters removed, trimmed. */
function shown(value: unknown): string {
  return str(value).replace(HIDDEN, '').trim();
}

function shownOrNull(value: unknown): string | null {
  return value === null ? null : shown(value);
}

/** An array of at most `max` items (bounded work on an untrusted answer). */
function bounded(value: unknown, max: number): unknown[] {
  const items = arr(value);
  return items.length <= max ? items : fail();
}

function positiveIntOrNull(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fail();
}

function positiveInt(value: unknown): number {
  return positiveIntOrNull(value) ?? fail();
}

/** An exact-decimal amount → EGP minor units; anything not exact is off-contract. */
function minor(value: unknown): number {
  const amount4 = parseAmount4(str(value));
  if (amount4 === null) return fail();
  return amount4ToMinor(amount4, CURRENCY_EXPONENT) ?? fail();
}

function minorOrNull(value: unknown): number | null {
  return value === null ? null : minor(value);
}

/**
 * A DISPLAY-only amount (line tax, return totals): exact to 10⁻⁴ on the wire
 * (return pricing yields fractions of a piastre), shown rounded half away from
 * zero to EGP minor units. Never used for a payout or a sale total.
 */
function shownMinor(value: unknown): number {
  const amount4 = parseAmount4(str(value));
  if (amount4 === null) return fail();
  const rounded = (amount4 + 50n) / 100n;
  const minorUnits = Number(rounded);
  return Number.isSafeInteger(minorUnits) ? minorUnits : fail();
}

function shownMinorOrNull(value: unknown): number | null {
  return value === null ? null : shownMinor(value);
}

function currency(value: unknown): void {
  if (value !== CURRENCY) fail();
}

const NAME_SOURCES: readonly SaleHistoryNameSource[] = ['snapshot', 'current', 'unavailable'];
const ERP_STATES: readonly SaleHistoryErpState[] = ['posted', 'pending', 'failed', 'unknown'];
const SYNC_STATUSES: readonly SaleHistorySyncStatus[] = [
  'captured',
  'synced',
  'failed-retryable',
  'failed-needs-repair',
];
const MARKS: readonly SaleHistoryReprintMark[] = ['voided', 'returned'];
const KINDS: readonly SaleHistoryReprintKind[] = ['duplicate', 'sale_record'];

function readItem(value: unknown): {
  row: WireHistoryPage['rows'][number];
  operatorRef: string | null;
} {
  const item = obj(value);
  const device = obj(item['device']);
  const operator = obj(item['operator']);
  currency(item['currencyCode']);
  return {
    // Lower-cased, as the session's cashier user id is (OD-534-1 cross-check).
    operatorRef: uuidOrNull(operator['userRef'])?.toLowerCase() ?? null,
    row: {
      sale_ref: uuid(item['saleRef']),
      sale_number: shownOrNull(item['saleNumber']),
      business_day: day(item['businessDate']),
      occurred_at: instant(item['occurredAt']),
      received_at: instant(item['receivedAt']),
      device_label: shownOrNull(device['label']),
      device_label_source: oneOf(device['labelSource'], NAME_SOURCES),
      operator_display_name: shownOrNull(operator['displayName']),
      operator_name_source: oneOf(operator['nameSource'], NAME_SOURCES),
      total_minor: minor(item['posTotal']),
      sync_status: oneOf(item['syncStatus'], SYNC_STATUSES),
      voided: bool(item['voided']),
      return_state: oneOf(item['returnState'], ['none', 'partial', 'full'] as const),
      erp_state: oneOf(item['erpPostingState'], ERP_STATES),
    },
  };
}

function readPage(json: unknown): WireHistoryPage {
  const page = obj(json);
  const items = arr(page['items']).map(readItem);
  if (items.length > 100) fail();
  const cursor = strOrNull(page['nextCursor']);
  if (cursor !== null && !CURSOR.test(cursor)) fail();
  const zone = str(page['storeTimezone']);
  if (zone.length === 0) fail();
  return {
    rows: items.map((i) => i.row),
    operator_refs: items.map((i) => i.operatorRef),
    next_cursor: cursor,
    as_of: instant(page['asOf']),
    store_timezone: zone,
    visibility: oneOf(page['visibility'], ['store', 'own_sales'] as const),
    from_day: day(page['from']),
    to_day: day(page['to']),
  };
}

function readLine(value: unknown): SaleHistoryLine {
  const line = obj(value);
  currency(line['currencyCode']);
  return {
    line_ref: uuid(line['lineRef']),
    sequence: positiveIntOrNull(line['sequence']),
    name: shown(line['lineName']),
    unit_price_minor: minor(line['unitPrice']),
    quantity: quantity(line['quantity']),
    line_minor: minor(line['lineAmount']),
    tax_minor: shownMinorOrNull(line['taxAmount']),
    unit: shown(line['unit']),
    returned_quantity: quantity(line['returnedQuantity']),
  };
}

function readTender(value: unknown): SaleHistoryTender {
  const tender = obj(value);
  return {
    method: oneOf(tender['method'], ['cash', 'card_external'] as const),
    amount_minor: minor(tender['amount']),
    reference: shownOrNull(tender['reference']),
    sequence: positiveIntOrNull(tender['sequence']),
  };
}

function readReturn(value: unknown): SaleHistoryReturn {
  const entry = obj(value);
  return {
    return_ref: uuid(entry['returnRef']),
    recorded_at: instant(entry['recordedAt']),
    business_day: day(entry['businessDate']),
    total_minor: shownMinor(entry['returnTotal']),
    lines: bounded(entry['lines'], 500).map((raw) => {
      const line = obj(raw);
      return {
        line_ref: uuid(line['lineRef']),
        quantity: quantity(line['quantity']),
        line_minor: shownMinor(line['lineAmount']),
      };
    }),
  };
}

function readHeader(value: unknown): SaleHistoryDetail['receipt_header'] {
  if (value === null) return null;
  const header = obj(value);
  return {
    branch_name: shown(header['branchName']),
    branch_address: shown(header['branchAddress']),
    tax_registration_id: shown(header['taxRegistrationId']),
  };
}

function readVoid(value: unknown): SaleHistoryDetail['void'] {
  if (value === null) return null;
  const entry = obj(value);
  const role = entry['approverRole'];
  return {
    voided_at: instant(entry['voidedAt']),
    void_business_day: dayOrNull(entry['voidBusinessDate']),
    approved: bool(entry['approved']),
    approver_role:
      role === null ? null : oneOf(role, ['owner', 'tenant_admin', 'store_manager'] as const),
  };
}

function readErp(value: unknown): SaleHistoryDetail['erp'] {
  const erp = obj(value);
  const reversal = erp['reversal'];
  return {
    sale: oneOf(erp['sale'], ERP_STATES),
    sale_document_ref: shownOrNull(erp['saleDocumentRef']),
    reversal: reversal === null ? null : oneOf(reversal, ERP_STATES),
    reversal_document_ref: shownOrNull(erp['reversalDocumentRef']),
  };
}

function readEligibility(value: unknown): SaleHistoryDetail['reprint'] {
  const reprint = obj(value);
  if (reprint['saleRecord'] !== 'allowed') fail();
  return {
    duplicate: oneOf(reprint['duplicate'], [
      'allowed',
      'unavailable_incomplete',
      'unavailable_voided',
    ] as const),
    marks: arr(reprint['marks']).map((m) => oneOf(m, MARKS)),
  };
}

function readDetail(json: unknown): WireHistoryDetail {
  const body = obj(json);
  const summary = readItem(body['summary']);
  return {
    operator_ref: summary.operatorRef,
    detail: {
      summary: summary.row,
      lines: bounded(body['lines'], 500).map(readLine),
      line_order: oneOf(body['lineOrder'], ['recorded', 'not_recorded'] as const),
      tender_state: oneOf(body['tenderState'], ['recorded', 'unknown'] as const),
      tenders: bounded(body['tenders'], 20).map(readTender),
      change_minor: minorOrNull(body['changeGiven']),
      settled_at: instantOrNull(body['settledAt']),
      receipt_number: shownOrNull(body['receiptNumber']),
      receipt_header: readHeader(body['receiptHeader']),
      void: readVoid(body['void']),
      returns: bounded(body['returns'], 100).map(readReturn),
      erp: readErp(body['erpPosting']),
      receipt_facts: oneOf(body['receiptFacts'], ['complete', 'partial'] as const),
      reprint: readEligibility(body['reprint']),
    },
  };
}

function readReprint(json: unknown): WireReprint {
  const body = obj(json);
  return {
    reprint_ref: uuid(body['reprintRef']),
    sale_ref: uuid(body['saleRef']),
    mode: oneOf(body['mode'], ['authorize', 'record'] as const),
    kind: oneOf(body['kind'], KINDS),
    marks: arr(body['marks']).map((m) => oneOf(m, MARKS)),
    copy_number: positiveInt(body['copyNumber']),
    recorded_at: instant(body['recordedAt']),
  };
}

function readOrNull<T>(read: (json: unknown) => T, json: unknown): T | null {
  try {
    return read(json);
  } catch (error) {
    if (error instanceof OffContract) return null;
    throw error;
  }
}

/** A `SaleHistoryPage` body, or null when any field is off-contract. */
export function readHistoryPage(json: unknown): WireHistoryPage | null {
  return readOrNull(readPage, json);
}

/** A `SaleHistoryDetail` body, or null when any field is off-contract. */
export function readHistoryDetail(json: unknown): WireHistoryDetail | null {
  return readOrNull(readDetail, json);
}

/** A `SaleReprint` body, or null when any field is off-contract. */
export function readReprintBody(json: unknown): WireReprint | null {
  return readOrNull(readReprint, json);
}

/** True when `value` is a cursor Backend-Core could have issued. */
export function isServerCursor(value: string): boolean {
  return CURSOR.test(value);
}
