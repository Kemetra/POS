/**
 * RT-15 S2 — D-c cash-only refunds, failing closed on tender evidence
 * (Codex P1 on e4e6870).
 *
 * A sale is cash-refundable ONLY when at least one source POSITIVELY proves it
 * was paid entirely in cash and no source contradicts that:
 *
 *   local  `sales.tender_lines_summary_json`
 *          non-empty, readable, every entry `cash`        → proves cash
 *          `[]` (tender-unknown on the capture path)       → proves nothing
 *          unreadable, or any non-cash / malformed entry  → contradicts
 *   server `Sale.tenders` (RT-77)
 *          present, non-empty, every entry `cash`          → proves cash
 *          absent or `[]` (pre-RT-77 / pre-cutoff capture) → proves nothing
 *          any non-cash entry                             → contradicts
 *
 * Any contradiction → `card_tender_blocked`; neither source proving cash →
 * `tender_unknown`.
 */
import type { LocalReturnRefusal } from '../../shared/returns/types.js';
import type { SaleRow } from '../sales/repositories/sales.repository.js';
import { parseJsonBody } from './returns-wire.js';
import type { WireSale } from './returns-wire.js';

export type TenderEvidence = 'cash' | 'none' | 'non_cash';

function methodsEvidence(methods: readonly unknown[]): TenderEvidence {
  if (methods.length === 0) return 'none';
  return methods.every((m) => m === 'cash') ? 'cash' : 'non_cash';
}

/** What the till's own frozen tender summary proves. */
export function localTenderEvidence(
  sale: Pick<SaleRow, 'tender_lines_summary_json'>,
): TenderEvidence {
  const parsed = parseJsonBody(sale.tender_lines_summary_json);
  if (!Array.isArray(parsed)) return 'non_cash';
  return methodsEvidence(
    parsed.map((line) => (line as { tender_type?: unknown } | null)?.tender_type),
  );
}

/** What the live server sale's `tenders` prove. */
export function serverTenderEvidence(sale: Pick<WireSale, 'tenders'>): TenderEvidence {
  return methodsEvidence((sale.tenders ?? []).map((t) => t.method));
}

/** D-c verdict over both sources: null = provably all-cash; else the refusal. */
export function cashOnlyVerdict(sources: readonly TenderEvidence[]): LocalReturnRefusal | null {
  if (sources.includes('non_cash')) return 'card_tender_blocked';
  return sources.includes('cash') ? null : 'tender_unknown';
}
