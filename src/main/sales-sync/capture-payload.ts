/**
 * 011-sale-sync-capture-up T023 — `buildCapturePayload`.
 *
 * Maps a durable `SaleRow` → the `CaptureSalePayload` body POSTed to DP2
 * `captureSale` (`POST /api/pos/v1/sales`). Pure: no I/O, no clock, no float.
 *
 * Invariants (spec FR-2/FR-9/FR-10):
 *   • `externalId` is DETERMINISTIC from the sale — derived from the existing
 *     008 idempotency anchor `envelope_handoff_action_id` — so every retry of the
 *     same sale carries the same key and the backend dedup `(tenant, sourceSystem,
 *     externalId)` collapses retries to one record.
 *   • Money is the Sale's integer minor units VERBATIM. The `sales` columns are
 *     already `INTEGER` at rest (migrations 0020/0028); there is no float anywhere.
 *   • Tenders (RT-79, RT-10 D1/D2) are emitted ONLY when a rollout cutoff is
 *     configured AND the sale was finalized at/after it. Default (no cutoff) is
 *     byte-identical to the pre-RT-79 payload and never reads
 *     `tender_lines_summary_json`. With a FUTURE cutoff (later than the restart that
 *     loads it) every retry of a given sale sends an identical body; a changed body
 *     under the same Idempotency-Key is a 409 payload-hash mismatch on the server.
 *   • Lines come from the frozen `lines_json` snapshot (LineSnapshot[]).
 */

import type { SaleRow } from '../sales/repositories/sales.repository.js';

/** A single line in the capture payload. Money is integer minor units. */
export interface CaptureSaleLine {
  lineRef: string;
  productRef: string;
  /** Human-readable line label, frozen from the cart snapshot's `display_name`. */
  lineName: string;
  quantity: number;
  unitPriceMinor: number;
  lineAmountMinor: number;
}

/** One way the sale was paid. `amountMinor` is NET of change. No card data/reference (D-A). */
export interface CaptureSaleTender {
  method: 'cash' | 'card_external';
  amountMinor: number;
}

/** The `captureSale` request body. Money is integer minor units. */
export interface CaptureSalePayload {
  externalId: string;
  sourceSystem: 'pos-pulse';
  tenantId: string;
  branchId: string;
  terminalId: string;
  operatorId: string;
  occurredAt: string;
  totalMinor: number;
  lines: CaptureSaleLine[];
  /** RT-79: present only for a post-cutoff sale with sendable tender lines. */
  tenders?: CaptureSaleTender[];
}

export interface BuildCapturePayloadOptions {
  /** ISO instant; sales finalized at/after it carry `tenders`. null/undefined = off. */
  tendersSince?: string | null | undefined;
}

/**
 * A tendered sale that must never be sent (voucher, unknown method, corrupt amounts,
 * unreadable summary). The engine dead-letters it with this reason rather than
 * sending a fabricated method (RT-10 D2).
 */
export class TenderNotSendableError extends Error {
  constructor(reason: string) {
    super(`tender not sendable: ${reason}`);
    this.name = 'TenderNotSendableError';
  }
}

const SOURCE_SYSTEM = 'pos-pulse' as const;

/** The frozen line snapshot shape persisted in `sales.lines_json` (008 T028a). */
interface PersistedLineSnapshot {
  line_id: string;
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
}

/** The frozen summary line shape (`buildRedactedTenderLinesSummary`). */
interface PersistedTenderLine {
  tender_type?: unknown;
  amount_applied_minor?: unknown;
  change_due_minor?: unknown;
}

const TENDER_METHOD: Readonly<Record<string, CaptureSaleTender['method']>> = {
  cash: 'cash',
  external_card_terminal: 'card_external',
};

/**
 * RFC 3339 instant with an EXPLICIT zone (`Z` or `+hh:mm`). `Date.parse` alone would also
 * accept date-only, zone-less (terminal-local) and locale formats, turning the gate on
 * for an unintended cutoff.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * `Date.parse` silently rolls calendar-invalid fields over (Feb 30 -> Mar 2), so check
 * each field is in range before trusting it.
 */
function isCalendarValid(m: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offsetOk = m[7] === undefined || (Number(m[7]) <= 23 && Number(m[8]) <= 59);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetOk
  );
}

/**
 * Parse `POS_PULSE_FEATURE_SALE_TENDERS_SINCE`. Unset, blank, not an explicit-zone ISO
 * instant, or unparseable -> null (tenders OFF — fail-safe). A valid instant -> its
 * canonical UTC ISO string.
 */
export function parseTendersSince(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  const match = ISO_INSTANT.exec(value);
  if (match === null || !isCalendarValid(match)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function isSafeNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Frozen `tender_lines_summary_json` -> contract tenders: cash NET of change,
 * `external_card_terminal` -> `card_external` (reference deliberately omitted), one
 * entry per method in first-seen order, zero-net entries dropped. Throws
 * `TenderNotSendableError` for anything that cannot be sent faithfully.
 */
function buildTenders(sale: SaleRow): CaptureSaleTender[] {
  let lines: unknown;
  try {
    lines = JSON.parse(sale.tender_lines_summary_json);
  } catch {
    throw new TenderNotSendableError('unreadable tender summary');
  }
  if (!Array.isArray(lines)) throw new TenderNotSendableError('tender summary is not a list');
  if (lines.length === 0) return []; // tender-unknown (RT-10 D8): nothing to reconcile

  const net = new Map<CaptureSaleTender['method'], number>();
  for (const raw of lines as unknown[]) {
    if (typeof raw !== 'object' || raw === null) {
      throw new TenderNotSendableError('malformed tender line');
    }
    const line = raw as PersistedTenderLine;
    const method =
      typeof line.tender_type === 'string' ? TENDER_METHOD[line.tender_type] : undefined;
    if (method === undefined) {
      throw new TenderNotSendableError(`unsupported tender type ${String(line.tender_type)}`);
    }
    const applied = line.amount_applied_minor;
    const change = line.change_due_minor ?? 0;
    if (!isSafeNonNegativeInt(applied) || !isSafeNonNegativeInt(change) || change > applied) {
      throw new TenderNotSendableError(`invalid ${method} amount`);
    }
    net.set(method, (net.get(method) ?? 0) + (applied - change));
  }
  const sum = [...net.values()].reduce((a, b) => a + b, 0);
  if (sum !== sale.subtotal_minor) {
    throw new TenderNotSendableError(
      `tenders sum ${String(sum)} != sale total ${String(sale.subtotal_minor)}`,
    );
  }
  return [...net]
    .filter(([, amountMinor]) => amountMinor > 0)
    .map(([method, amountMinor]) => ({
      method,
      amountMinor,
    }));
}

function tendersApply(sale: SaleRow, tendersSince: string | null | undefined): boolean {
  if (tendersSince === null || tendersSince === undefined) return false;
  const finalized = Date.parse(sale.finalized_at);
  return !Number.isNaN(finalized) && finalized >= Date.parse(tendersSince);
}

/**
 * Deterministic external id from the sale. The handoff action id is 008's
 * one-Sale-per-handoff idempotency anchor (unique index), so it is a stable,
 * collision-free basis. Namespaced to make the POS origin explicit on the wire.
 */
export function deriveExternalId(sale: SaleRow): string {
  return `pos-pulse:${sale.envelope_handoff_action_id}`;
}

export function buildCapturePayload(
  sale: SaleRow,
  options: BuildCapturePayloadOptions = {},
): CaptureSalePayload {
  const snapshots = JSON.parse(sale.lines_json) as PersistedLineSnapshot[];
  const lines: CaptureSaleLine[] = snapshots.map((s) => ({
    lineRef: s.line_id,
    productRef: s.item_ref,
    lineName: s.display_name,
    quantity: s.quantity,
    unitPriceMinor: s.unit_price_minor,
    lineAmountMinor: s.line_subtotal_minor,
  }));

  const tenders = tendersApply(sale, options.tendersSince) ? buildTenders(sale) : [];

  return {
    externalId: deriveExternalId(sale),
    sourceSystem: SOURCE_SYSTEM,
    tenantId: sale.tenant_id,
    branchId: sale.branch_id,
    terminalId: sale.terminal_id,
    operatorId: sale.selling_operator_id,
    occurredAt: sale.finalized_at,
    totalMinor: sale.subtotal_minor,
    lines,
    ...(tenders.length > 0 ? { tenders } : {}),
  };
}
