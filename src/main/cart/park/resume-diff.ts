/**
 * RT-440 (PK-2, spec 024 §3.3 / K4) — compare a parked sale's lines with the
 * local catalogue. Pure: the catalogue is reached through `PriceLookup`.
 *
 *   • a line whose unit price changed is a `change` (old, new);
 *   • a line whose product is gone (`not_found`, or inactive: not sellable)
 *     is `unavailable`, removed only on an accepted resume (R-1);
 *   • an unreadable catalogue — empty, missing, a corrupt price — answers
 *     `catalogue_unavailable` for the whole sale: an infrastructure failure is
 *     never read as "every product was removed".
 *
 * Promotions are out of scope (Pricing 610): price and availability only.
 */
import { createHash } from 'node:crypto';

import type { ResumePriceChange, ResumeUnavailableLine } from '../../../shared/cart/park-types.js';
import { computeLineSubtotal, LineSubtotalError } from '../line-subtotal.js';

/** The current local price of an item, as the catalogue read model answers it. */
export type PriceAnswer =
  | { kind: 'price'; unit_price_minor: number }
  | { kind: 'gone' }
  | { kind: 'unavailable' };

export type PriceLookup = (tenantId: string, itemRef: string) => PriceAnswer;

export interface ParkedLine {
  line_id: string;
  item_ref: string;
  display_name: string;
  quantity: number;
  unit_price_minor: number;
}

/** A change with the new line subtotal main will write. */
export interface PlannedReprice extends ResumePriceChange {
  new_subtotal_minor: number;
}

export interface ResumeDiff {
  changes: PlannedReprice[];
  unavailable: ResumeUnavailableLine[];
  diff_token: string;
}

export type ResumeDiffResult =
  | { kind: 'diff'; diff: ResumeDiff }
  | { kind: 'catalogue_unavailable' };

/**
 * Opaque digest of what the cashier accepts: the price changes and the
 * removals, by line id. The name and quantity are display only (RT-610) and
 * stay out of it, so the token is the same as before they were shown.
 */
function tokenOf(
  changes: readonly ResumePriceChange[],
  unavailable: readonly ResumeUnavailableLine[],
): string {
  const shown = {
    changes: changes.map((c) => [c.line_id, c.old_unit_minor, c.new_unit_minor]),
    unavailable: unavailable.map((u) => u.line_id),
  };
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 32);
}

/** The new subtotal, or null when it is not a safe integer. */
function subtotalOrNull(quantity: number, unit: number): number | null {
  try {
    return computeLineSubtotal(quantity, unit);
  } catch (err) {
    if (err instanceof LineSubtotalError) return null;
    /* v8 ignore next */
    throw err;
  }
}

export function computeResumeDiff(
  tenantId: string,
  lines: readonly ParkedLine[],
  lookup: PriceLookup,
): ResumeDiffResult {
  const ordered = [...lines].sort((a, b) => a.line_id.localeCompare(b.line_id));
  const changes: PlannedReprice[] = [];
  const unavailable: ResumeUnavailableLine[] = [];
  for (const line of ordered) {
    const answer = lookup(tenantId, line.item_ref);
    if (answer.kind === 'unavailable') return { kind: 'catalogue_unavailable' };
    if (answer.kind === 'gone') {
      unavailable.push({
        line_id: line.line_id,
        display_name: line.display_name,
        quantity: line.quantity,
      });
      continue;
    }
    if (answer.unit_price_minor === line.unit_price_minor) continue;
    const subtotal = subtotalOrNull(line.quantity, answer.unit_price_minor);
    if (subtotal === null) return { kind: 'catalogue_unavailable' };
    changes.push({
      line_id: line.line_id,
      display_name: line.display_name,
      quantity: line.quantity,
      old_unit_minor: line.unit_price_minor,
      new_unit_minor: answer.unit_price_minor,
      new_subtotal_minor: subtotal,
    });
  }
  return {
    kind: 'diff',
    diff: { changes, unavailable, diff_token: tokenOf(changes, unavailable) },
  };
}

/** Did the cashier see (and accept) exactly this diff? */
export function isAcceptedDiff(
  diff: ResumeDiff,
  req: { accept_changes: boolean; diff_token: string },
): boolean {
  if (diff.diff_token !== req.diff_token) return false;
  const nothingToAccept = diff.changes.length === 0 && diff.unavailable.length === 0;
  return nothingToAccept || req.accept_changes;
}

/** The catalogue read model as a `PriceLookup` (`ProductRepo.resolveForSeam`). */
export function createCataloguePriceLookup(repo: {
  resolveForSeam(
    tenantId: string,
    productId: string,
  ):
    | { kind: 'found'; product: { price_minor: number; active: boolean } }
    | { kind: 'not_found' }
    | { kind: 'unavailable' };
}): PriceLookup {
  return (tenantId, itemRef) => {
    const result = repo.resolveForSeam(tenantId, itemRef);
    if (result.kind === 'unavailable') return { kind: 'unavailable' };
    if (result.kind === 'not_found' || !result.product.active) return { kind: 'gone' };
    const price = result.product.price_minor;
    return Number.isSafeInteger(price) && price >= 0
      ? { kind: 'price', unit_price_minor: price }
      : { kind: 'unavailable' };
  };
}
