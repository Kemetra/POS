/**
 * RT-541 — the recorded lines of a sale, projected for the sale detail.
 *
 * Source: the frozen `sales.lines_json` snapshot written at finalize (008
 * T028a, the `LineSnapshot[]` of the handoff envelope). The receipt template
 * reads the same column (`receipts-payload.ts`) through the shared
 * {@link LineSnapshotJson} shape.
 *
 * Honest states, never a guess:
 *   • '[]' is the migration 0028 default for sales finalized before line
 *     snapshots existed (a finalized sale always has at least one line), so it
 *     is `not_recorded`, not an empty sale;
 *   • a malformed snapshot is `unreadable`, never thrown across IPC.
 */

import type { SaleLineView, SaleLinesView } from '../../shared/sales/types.js';

/**
 * One element of `sales.lines_json` (mirrors `LineSnapshot` from the cart
 * handoff envelope); only the display fields are named.
 */
export interface LineSnapshotJson {
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
  line_subtotal_minor: number;
  note: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Integer minor units / whole quantities only (no floats for money). */
function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function hasTextFields(value: Record<string, unknown>): boolean {
  const { item_ref, display_name, note } = value;
  const noteOk = note === null || typeof note === 'string';
  return typeof item_ref === 'string' && typeof display_name === 'string' && noteOk;
}

function hasWholeAmounts(value: Record<string, unknown>): boolean {
  return [value.quantity, value.unit_price_minor, value.line_subtotal_minor].every(isWhole);
}

function isLineSnapshot(value: unknown): value is LineSnapshotJson {
  return isRecord(value) && hasTextFields(value) && hasWholeAmounts(value);
}

/** The display fields of one snapshot element, or null when malformed. */
function toLineView(value: unknown): SaleLineView | null {
  if (!isLineSnapshot(value)) return null;
  const { item_ref, display_name, quantity, unit_price_minor, line_subtotal_minor, note } = value;
  return { item_ref, display_name, quantity, unit_price_minor, line_subtotal_minor, note };
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** The sale-detail view of a `sales.lines_json` value. Never throws. */
export function projectSaleLines(linesJson: string): SaleLinesView {
  const parsed = parse(linesJson);
  if (!Array.isArray(parsed)) return { state: 'unreadable' };
  if (parsed.length === 0) return { state: 'not_recorded' };
  const items: SaleLineView[] = [];
  for (const element of parsed) {
    const line = toLineView(element);
    if (line === null) return { state: 'unreadable' };
    items.push(line);
  }
  return { state: 'recorded', items };
}
