/**
 * RT-15 S2 — exact return pricing (AC6). No float ever touches money here.
 *
 * Backend-Core prices a return from the frozen sale line by the
 * cumulative-difference rule (`sales.yaml` 1.4.0-draft, `recordReturn`):
 *
 *   for a line sold in quantity Q with `lineAmount` A, of which c is already
 *   returned, returning q is priced  round4(A × (c + q) / Q) − round4(A × c / Q)
 *
 * where round4 is Postgres `round(numeric, 4)` (half away from zero). Amounts
 * are therefore exact in units of 10⁻⁴; this module works in those units as
 * `bigint` and converts to the currency's minor units only when the value is
 * exactly representable (a cash refund cannot pay a fraction of a minor unit).
 */

/** Ten-thousandths per whole currency unit (the contract's `numeric(19,4)`). */
const SCALE_DIGITS = 4;

const DECIMAL_AMOUNT = /^(\d{1,15})(?:\.(\d{1,4}))?$/;
const DECIMAL_QUANTITY = /^(\d{1,13})(?:\.(\d{1,6}))?$/;

/**
 * A non-negative contract `DecimalAmount` string → bigint ten-thousandths.
 * Null for anything else (a negative amount, a float-ish or malformed value).
 */
export function parseAmount4(value: string): bigint | null {
  const match = DECIMAL_AMOUNT.exec(value);
  if (match === null) return null;
  const fraction = (match[2] ?? '').padEnd(SCALE_DIGITS, '0');
  return BigInt(`${match[1] ?? '0'}${fraction}`);
}

/**
 * A contract quantity string → a whole number, or null when it is malformed,
 * fractional (RT-15 D-e: whole quantities only) or not a safe integer.
 * `"2"`, `"2.000000"` → 2; `"2.5"` → null.
 */
export function parseWholeQuantity(value: string): number | null {
  const match = DECIMAL_QUANTITY.exec(value);
  if (match === null) return null;
  if (/[1-9]/.test(match[2] ?? '')) return null;
  const whole = Number(match[1]);
  return Number.isSafeInteger(whole) ? whole : null;
}

/** round4(amount4 × n / of), half away from zero, for non-negative operands. */
function shareOf(amount4: bigint, n: bigint, of: bigint): bigint {
  return (2n * amount4 * n + of) / (2n * of);
}

export interface ReturnLinePricingInput {
  /** The sale line's `lineAmount`, in ten-thousandths. */
  readonly lineAmount4: bigint;
  /** Q — the whole quantity sold (must be > 0). */
  readonly sold: number;
  /** c — the whole quantity already returned. */
  readonly returned: number;
  /** q — the whole quantity returned now. */
  readonly quantity: number;
}

/** The contract price of returning `quantity` on one line, in ten-thousandths. */
export function priceReturnLine(input: ReturnLinePricingInput): bigint {
  const sold = BigInt(input.sold);
  const before = BigInt(input.returned);
  const after = before + BigInt(input.quantity);
  return shareOf(input.lineAmount4, after, sold) - shareOf(input.lineAmount4, before, sold);
}

/**
 * Ten-thousandths → integer minor units for a currency with `exponent` minor
 * digits (0..4). Null when the value is not a whole number of minor units or
 * not a safe integer — such an amount cannot be paid out exactly in cash.
 */
export function amount4ToMinor(amount4: bigint, exponent: number): number | null {
  if (!Number.isInteger(exponent)) return null;
  if (exponent < 0 || exponent > SCALE_DIGITS) return null;
  const divisor = 10n ** BigInt(SCALE_DIGITS - exponent);
  if (amount4 < 0n || amount4 % divisor !== 0n) return null;
  const minor = Number(amount4 / divisor);
  return Number.isSafeInteger(minor) ? minor : null;
}
