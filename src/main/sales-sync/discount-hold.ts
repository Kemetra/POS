/**
 * RT-856 (RT-699 I3, doc 28 §6 DEP-1 guard) — hold discounted sales from sync
 * until the capture path can send them.
 *
 * Backend-Core accepts the discount capture shape (RT-740) but does not store
 * it, POS does not send it yet (`sales.yaml` re-pin and the line `discount`
 * are RT-858), and the ERPNext-Connector cannot post a discounted line
 * (RT-857). Sent today, a discounted sale would carry gross `lineAmount`s with
 * a net total: Backend-Core answers 4xx and the drain dead-letters it, which
 * is terminal. So the drain HOLDS it instead: skipped untouched (no POST, no
 * state row, no attempt), still pending, never dead-lettered. Once the switch
 * is on, the same stored sale drains on the next tick with no requeue step.
 *
 * The switch is a code constant, not an environment variable, on purpose: it
 * must not be reachable by ops before RT-858 ships the capture rule. RT-858
 * flips {@link SALE_DISCOUNT_CAPTURE_SUPPORTED} in the same change.
 */
import type { SaleRow } from '../sales/repositories/sales.repository.js';

/** Whether the capture path can send a discounted sale. RT-858 turns it on. */
export const SALE_DISCOUNT_CAPTURE_SUPPORTED = false;

/** The closed set of reasons a pending sale is held from sync. */
export const SALE_SYNC_HELD_REASONS = ['discount_capture_unavailable'] as const;
export type SaleSyncHeldReason = (typeof SALE_SYNC_HELD_REASONS)[number];

/** The held subset of the pending sales, with its named reason. Counts only (P7). */
export interface SaleSyncHold {
  reason: SaleSyncHeldReason;
  count: number;
}

function hasDiscount(line: unknown): boolean {
  if (line === null || typeof line !== 'object') return false;
  const discount = (line as Record<string, unknown>)['discount'];
  return discount !== undefined && discount !== null;
}

/**
 * Whether any line of the sale carries a frozen `discount`. An unreadable
 * snapshot counts as discounted: it is held, never sent as a guess.
 */
export function saleHasLineDiscount(sale: Pick<SaleRow, 'lines_json'>): boolean {
  let lines: unknown;
  try {
    lines = JSON.parse(sale.lines_json);
  } catch {
    return true;
  }
  return !Array.isArray(lines) || lines.some(hasDiscount);
}
