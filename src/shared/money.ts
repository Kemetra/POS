/**
 * T057 — Money module.
 *
 * Per Constitution Principle II: every monetary value in POS-Pulse is an
 * integer count of minor units (piastres for EGP), wrapped in an immutable
 * `Money` value. Floats are forbidden anywhere in the value's lifecycle.
 *
 * In feature 001-foundation no domain code yet uses this module — it exists
 * so that every later feature consumes a single, well-tested arithmetic seam
 * instead of inventing its own.
 *
 * Source-of-truth policy: this file is canonical. specs/001-foundation/
 * contracts/money.ts is a planning snapshot and is NOT re-synced.
 *
 * Coverage gate: ≥95% line + branch enforced in vitest.config.ts. Any new
 * branch added here MUST be exercised by a targeted test (T058 rule).
 */

/**
 * ISO-4217-style currency code. The MVP supports EGP only; additional codes
 * MUST go through an explicit constitution amendment (multi-currency
 * rounding rules differ across jurisdictions).
 */
export type CurrencyCode = 'EGP';

/**
 * Immutable monetary value.
 *  - `amount` is an INTEGER number of minor units; non-integer or
 *    non-safe-integer inputs are rejected at construction time.
 *  - `currency` MUST match across the operands of any arithmetic op;
 *    mixing currencies throws.
 */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ['EGP'];

/**
 * EGP minor-unit divisor. Hard-coded for 001 since EGP is the only
 * supported currency. Multi-currency support requires a per-currency table
 * AND a constitution amendment per the contract.
 */
const EGP_MINOR_UNIT_DIVISOR = 100;

function isSupportedCurrency(c: unknown): c is CurrencyCode {
  return typeof c === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(c);
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money.${what}: amount must be a safe integer`);
  }
}

function assertSameCurrency(a: Money, b: Money, op: string): void {
  // Cast through unknown so the comparison is not narrowed away. Today
  // CurrencyCode is the single literal 'EGP' so TypeScript proves
  // `a.currency !== b.currency` is statically false — but a caller can
  // still defeat the type system at a boundary (e.g., parsed JSON,
  // `as 'EGP'` casts). The runtime check is real defense-in-depth.
  if ((a.currency as unknown) !== (b.currency as unknown)) {
    throw new Error(`Money.${op}: currency mismatch`);
  }
}

function freezeMoney(amount: number, currency: CurrencyCode): Money {
  return Object.freeze({ amount, currency });
}

/**
 * Construct a Money value. Throws on:
 *   - non-integer or non-safe-integer `amount`
 *   - unsupported `currency`
 */
export function of(amount: number, currency: CurrencyCode): Money {
  if (!isSupportedCurrency(currency)) {
    throw new Error(`Money.of: unsupported currency`);
  }
  assertSafeInteger(amount, 'of');
  return freezeMoney(amount, currency);
}

/** Convenience: zero in the given currency. */
export function zero(currency: CurrencyCode): Money {
  return of(0, currency);
}

/** `a + b`. Throws on currency mismatch or unsafe-integer result. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'add');
  const result = a.amount + b.amount;
  assertSafeInteger(result, 'add');
  return freezeMoney(result, a.currency);
}

/** `a - b`. Throws on currency mismatch or unsafe-integer result. */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'subtract');
  const result = a.amount - b.amount;
  assertSafeInteger(result, 'subtract');
  return freezeMoney(result, a.currency);
}

/**
 * Multiply by an integer quantity. Throws on:
 *   - non-safe-integer `quantity`
 *   - unsafe-integer result
 *
 * `quantity` may be zero (returns zero), one (returns equal value), or
 * negative (flips sign). Per the contract, the result MUST satisfy
 * `Number.isSafeInteger`.
 */
export function multiply(value: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity)) {
    throw new RangeError('Money.multiply: quantity must be a safe integer');
  }
  const result = value.amount * quantity;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Money.multiply: result is not a safe integer');
  }
  return freezeMoney(result, value.currency);
}

/**
 * Distribute `value.amount` into `n` parts whose sum equals `value.amount`
 * exactly. Rounding is "remainder-to-the-front":
 *
 *   allocate(of(100, 'EGP'), 3) → [34, 33, 33]
 *   allocate(of(-100, 'EGP'), 3) → [-34, -33, -33]   (most-negative first)
 *
 * Algorithm: `base = Math.trunc(amount / n)` (truncates toward zero, so it
 * rounds the same way for both signs); `remainder = amount - base * n`. If
 * the remainder is non-zero, distribute `sign(remainder)` increments to the
 * first `|remainder|` parts.
 *
 * Throws on `n ≤ 0` or non-integer `n`.
 */
export function allocate(value: Money, n: number): readonly Money[] {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new RangeError('Money.allocate: n must be a positive integer');
  }
  const base = Math.trunc(value.amount / n);
  const remainder = value.amount - base * n;
  // sign of remainder dictates direction of the first-parts adjustment.
  // For positive amount → remainder ≥ 0 → step = +1 distributed to first
  // `remainder` parts. For negative amount → remainder ≤ 0 → step = -1
  // distributed to first `|remainder|` parts.
  const step = remainder >= 0 ? 1 : -1;
  const adjustCount = Math.abs(remainder);
  const parts: Money[] = [];
  for (let i = 0; i < n; i++) {
    const partAmount = i < adjustCount ? base + step : base;
    parts.push(freezeMoney(partAmount, value.currency));
  }
  return Object.freeze(parts);
}

/**
 * Returns true for same-currency, same-amount values. Cross-currency
 * comparison returns FALSE (does NOT throw) — per the canonical contract
 * surface in this file. (tasks.md says "throws"; the contract wins per
 * source-of-truth policy.)
 */
export function equals(a: Money, b: Money): boolean {
  // Cast through unknown — see assertSameCurrency for rationale.
  if ((a.currency as unknown) !== (b.currency as unknown)) return false;
  return a.amount === b.amount;
}

/**
 * Three-way comparator: -1 / 0 / 1. Throws on currency mismatch.
 */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, 'compare');
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

/**
 * Format for ASCII display. EGP-only at this layer; locale-aware
 * formatting belongs in the renderer's `formatters` module (later feature).
 *
 *   format(of(12345, 'EGP'))   → "123.45 EGP"
 *   format(of(0, 'EGP'))       → "0.00 EGP"
 *   format(of(5, 'EGP'))       → "0.05 EGP"
 *   format(of(-12345, 'EGP'))  → "-123.45 EGP"
 */
export function format(value: Money): string {
  const sign = value.amount < 0 ? '-' : '';
  const abs = Math.abs(value.amount);
  const major = Math.trunc(abs / EGP_MINOR_UNIT_DIVISOR);
  const minor = abs - major * EGP_MINOR_UNIT_DIVISOR;
  const minorStr = String(minor).padStart(2, '0');
  return `${sign}${String(major)}.${minorStr} ${value.currency}`;
}

// RT-588 PROBE ONLY — deliberately untested code; the money.ts 95% gate must fail.
export function probeUncovered(value: Money): string {
  if (value.amount > 1000) {
    return 'big';
  }
  if (value.amount < -1000) {
    return 'small';
  }
  if (value.amount === 0) {
    return 'zero';
  }
  return 'other';
}
