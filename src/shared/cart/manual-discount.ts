/**
 * RT-854 (RT-699 I1; doc 28 §3, §11; spec 005 FR-022 / FR-024 RT-699
 * amendments) — the manual line discount math, shared by main (authority) and
 * the renderer (preview only).
 *
 * - The value rides in the placeholder's `placeholder_kind` as a canonical
 *   token: `manual_pct_<P>` (whole percent 1–100) or `manual_amt_<M>` (minor
 *   units ≥ 1). No leading zero, no sign, nothing else (OD-28-1/2/8).
 * - The amount is computed once per line, on the line gross, in integer minor
 *   units. A percent rounds half up: `floor((gross × P + 50) / 100)`, done by
 *   exact integer division so no float ever rounds (OD-28-3). Every
 *   intermediate is `Number.isSafeInteger`, otherwise the discount is refused.
 * - 0 ≤ net ≤ gross. An amount above the gross is refused; a percent that
 *   rounds to 0 is allowed (OD-28-4 = C, §11.1).
 * - The reason is a code from the closed list Backend-Core validates (§11.2).
 *
 * Pure and deterministic: the same frozen line and token always give the same
 * amount, so handoff, Sale, capture and receipt all derive the same number.
 */

export type ManualDiscountKind = 'percent' | 'amount';

export interface ManualDiscount {
  readonly kind: ManualDiscountKind;
  /** A whole percent 1–100, or an amount in minor units ≥ 1. */
  readonly value: number;
}

export interface ManualDiscountResult {
  readonly amount_minor: number;
  readonly net_minor: number;
}

/** The closed reason list (OD-28-9, RT-699 comment 12975; Backend-Core `DISCOUNT_REASON_CODES`). */
export const MANUAL_DISCOUNT_REASON_CODES = [
  'promotion',
  'loyal_or_contract_customer',
  'near_expiry_or_damaged',
  'price_correction',
] as const;

export type ManualDiscountReasonCode = (typeof MANUAL_DISCOUNT_REASON_CODES)[number];

const REASON_CODES: ReadonlySet<string> = new Set(MANUAL_DISCOUNT_REASON_CODES);

export function isManualDiscountReasonCode(value: unknown): value is ManualDiscountReasonCode {
  return typeof value === 'string' && REASON_CODES.has(value);
}

const PERCENT_PREFIX = 'manual_pct_';
const AMOUNT_PREFIX = 'manual_amt_';
/** A positive integer written canonically: no sign, no leading zero. */
const CANONICAL_POSITIVE = /^[1-9]\d*$/;
const MAX_PERCENT = 100;
const HALF = 50;

function parsePositive(digits: string): number | null {
  if (!CANONICAL_POSITIVE.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

function isValidGross(gross: number): boolean {
  return Number.isSafeInteger(gross) && gross >= 0;
}

function isValidDiscount(discount: ManualDiscount): boolean {
  if (!Number.isSafeInteger(discount.value) || discount.value < 1) return false;
  return discount.kind === 'amount' || discount.value <= MAX_PERCENT;
}

/** The discount a canonical token names, or null for anything else. */
export function parseManualDiscountToken(token: string): ManualDiscount | null {
  const prefixes: readonly [string, ManualDiscountKind][] = [
    [PERCENT_PREFIX, 'percent'],
    [AMOUNT_PREFIX, 'amount'],
  ];
  for (const [prefix, kind] of prefixes) {
    if (!token.startsWith(prefix)) continue;
    const value = parsePositive(token.slice(prefix.length));
    if (value === null) return null;
    const discount: ManualDiscount = { kind, value };
    return isValidDiscount(discount) ? discount : null;
  }
  return null;
}

/** The canonical token for a discount (the renderer sends this; main re-parses it). */
export function formatManualDiscountToken(discount: ManualDiscount): string {
  const prefix = discount.kind === 'percent' ? PERCENT_PREFIX : AMOUNT_PREFIX;
  return `${prefix}${String(discount.value)}`;
}

/** `floor(x / 100)` for a safe non-negative integer, exactly (no float division). */
function floorDiv100(x: number): number {
  return (x - (x % MAX_PERCENT)) / MAX_PERCENT;
}

function discountAmount(gross: number, discount: ManualDiscount): number | null {
  if (discount.kind === 'amount') return discount.value <= gross ? discount.value : null;
  const scaled = gross * discount.value;
  if (!Number.isSafeInteger(scaled)) return null;
  const rounded = scaled + HALF;
  return Number.isSafeInteger(rounded) ? floorDiv100(rounded) : null;
}

/**
 * The discount on one line's gross (`quantity × unit_price_minor`), or null
 * when it is refused: an invalid gross or discount, an amount above the gross,
 * or an intermediate outside the safe-integer range.
 */
export function computeManualDiscount(
  gross: number,
  discount: ManualDiscount,
): ManualDiscountResult | null {
  if (!isValidGross(gross) || !isValidDiscount(discount)) return null;
  const amount = discountAmount(gross, discount);
  if (amount === null) return null;
  return { amount_minor: amount, net_minor: gross - amount };
}

/** The discount amount a token gives on a line gross, or null when refused. */
export function lineDiscountMinor(gross: number, token: string): number | null {
  const discount = parseManualDiscountToken(token);
  if (discount === null) return null;
  return computeManualDiscount(gross, discount)?.amount_minor ?? null;
}

export interface DiscountTotals {
  readonly discount_total_minor: number;
  readonly total_due_minor: number;
}

interface TotalsLine {
  readonly line_id: string;
  readonly line_subtotal_minor: number;
}

interface TotalsPlaceholder {
  readonly line_id: string;
  readonly placeholder_kind: string;
}

/** Σ line gross, or null on overflow. */
function safeSum(values: readonly number[]): number | null {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

/** Each envelope line's discount, or null when one cannot be honoured. */
function lineDiscounts(
  lines: readonly TotalsLine[],
  placeholders: readonly TotalsPlaceholder[],
): number[] | null {
  const grossByLine = new Map(lines.map((line) => [line.line_id, line.line_subtotal_minor]));
  const seen = new Set<string>();
  const amounts: number[] = [];
  for (const placeholder of placeholders) {
    const gross = grossByLine.get(placeholder.line_id);
    // A placeholder left on a removed line discounts nothing.
    if (gross === undefined) continue;
    // One manual discount per line (OD-28-6).
    if (seen.has(placeholder.line_id)) return null;
    seen.add(placeholder.line_id);
    const amount = lineDiscountMinor(gross, placeholder.placeholder_kind);
    if (amount === null) return null;
    amounts.push(amount);
  }
  return amounts;
}

/**
 * The handoff envelope's `discount_total_minor` (Σ line discounts) and
 * `total_due_minor` (`subtotal_minor − discount_total_minor`), or null when a
 * discount cannot be honoured (a non-canonical token, a second discount on a
 * line, an amount above its line's gross) or a sum overflows.
 */
export function envelopeDiscountTotals(
  lines: readonly TotalsLine[],
  placeholders: readonly TotalsPlaceholder[],
): DiscountTotals | null {
  const subtotal = safeSum(lines.map((line) => line.line_subtotal_minor));
  const amounts = lineDiscounts(lines, placeholders);
  if (subtotal === null || amounts === null) return null;
  // Each amount ≤ its line gross, so the sum is ≤ the subtotal and safe.
  const discountTotal = amounts.reduce((sum, amount) => sum + amount, 0);
  return { discount_total_minor: discountTotal, total_due_minor: subtotal - discountTotal };
}
