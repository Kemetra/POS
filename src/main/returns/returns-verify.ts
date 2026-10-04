/**
 * RT-15 S2 — fail-closed correspondence checks on the server answers the
 * return flow trusts (Codex P2 on 50b591a + the trusted-field sweep).
 *
 * readSale (before any line is exposed or priced):
 *   • `saleRef` is the one requested (case-insensitive);
 *   • every line is in the sale's currency (the POS keeps no per-sale
 *     currency, so the sale's own is the anchor the confirmation is pinned to);
 *   • `lineRef`s are unique;
 *   • the lines correspond one-to-one to the till's frozen snapshot
 *     (`sales.lines_json`) on whole quantity, unit price and line amount in
 *     minor units, order-independent.
 * Why the snapshot match is exact (Backend-Core main 1e7c5b2): capture inserts
 * one `sale_lines` row per request line, values verbatim
 * (`apps/api/src/catalog/sales/sales.service.ts:342-364`; the pipe only
 * `schema.parse`s, `dto/capture-sale-request.pipe.ts:19-24`), into
 * `numeric(19,4)` / `numeric(19,6)` columns (`packages/db/drizzle/0012_sales.sql:150-161`),
 * and `readSale` serves those columns as-is (`sales.service.ts:451-462`,
 * projection `:773-784`) — only the decimal scale ("15.00" → "15.0000",
 * "3" → "3.000000") and the order (`ORDER BY sl.line_name`) differ, which the
 * minor-unit, order-independent comparison absorbs. The POS sends exactly the
 * snapshot (`capture-payload.ts` `buildCapturePayload` → `toWireBody`).
 *
 * recordReturn confirmation: every returned line is one the journal asked to
 * return, with the same whole quantity, and none twice (in `returns-dispatch`).
 */
import { exponentFor } from '../sales-sync/create-sale-sync-client.js';
import { amount4ToMinor, parseAmount4, parseWholeQuantity } from './returns-money.js';
import type { JournalLine } from './returns-repository.js';
import type { WireReturnLine, WireSale, WireSaleLine } from './returns-wire.js';

/** One frozen local line as `sales.lines_json` stores it (008 T028a). */
interface SnapshotLine {
  readonly quantity?: unknown;
  readonly unit_price_minor?: unknown;
  readonly line_subtotal_minor?: unknown;
}

function lineKey(parts: readonly unknown[]): string {
  return parts.map((p) => String(p)).join('|');
}

/** A contract amount string → integer minor units, or null. */
function toMinor(value: string, exponent: number): number | null {
  const amount4 = parseAmount4(value);
  return amount4 === null ? null : amount4ToMinor(amount4, exponent);
}

function isAllNumbers(values: readonly (number | null)[]): values is readonly number[] {
  return values.every((v) => v !== null);
}

function serverLineKey(line: WireSaleLine, exponent: number): string | null {
  const parts = [
    parseWholeQuantity(line.quantity),
    toMinor(line.unitPrice, exponent),
    toMinor(line.lineAmount, exponent),
  ];
  return isAllNumbers(parts) ? lineKey(parts) : null;
}

function snapshotKeys(linesJson: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(linesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return (parsed as SnapshotLine[]).map((l) =>
    lineKey([l.quantity, l.unit_price_minor, l.line_subtotal_minor]),
  );
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((key, i) => key === sortedB[i]);
}

function hasUniqueRefs(refs: readonly string[]): boolean {
  return new Set(refs.map((r) => r.toLowerCase())).size === refs.length;
}

/** The server lines are this sale's frozen lines (exact, order-independent). */
function matchesSnapshot(sale: WireSale, linesJson: string): boolean {
  const exponent = exponentFor(sale.currencyCode);
  const server = sale.lines.map((l) => serverLineKey(l, exponent));
  const local = snapshotKeys(linesJson);
  if (local === null || server.some((k) => k === null)) return false;
  return sameMultiset(server as string[], local);
}

export interface ExpectedSale {
  /** The saleRef that was requested. */
  readonly saleRef: string;
  /** The till's frozen `sales.lines_json`. */
  readonly linesJson: string;
}

/** True when the live `readSale` answer is the sale the till asked for. */
export function isExpectedSale(sale: WireSale, expected: ExpectedSale): boolean {
  if (sale.saleRef.toLowerCase() !== expected.saleRef.toLowerCase()) return false;
  if (sale.lines.some((l) => l.currencyCode !== sale.currencyCode)) return false;
  if (!hasUniqueRefs(sale.lines.map((l) => l.lineRef))) return false;
  return matchesSnapshot(sale, expected.linesJson);
}

/** Every returned line was requested, with the same whole quantity, none twice. */
export function returnedLinesMatch(
  requested: readonly JournalLine[],
  returned: readonly WireReturnLine[],
): boolean {
  if (!hasUniqueRefs(returned.map((l) => l.lineRef))) return false;
  const asked = new Map(requested.map((l) => [l.lineRef.toLowerCase(), l.quantity]));
  return returned.every(
    (l) => asked.get(l.lineRef.toLowerCase()) === parseWholeQuantity(l.quantity),
  );
}
