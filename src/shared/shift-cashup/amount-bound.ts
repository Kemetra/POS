/**
 * RT-278 S1 (plan `docs/design/vnext/29-rt278-shift-amount-bounds.md`, owner
 * decisions OD-278-1…3 and 7, RT-278 comment 12764) — the plausibility bound
 * on a shift amount typed or scanned into a shift money field.
 *
 * F-02: a 13-digit barcode in a money field is read as major units, so
 * `6221000000011` becomes ~6.2×10¹⁴ minor. The RT-239 scan guard stops a
 * burst in the UI; this rule is the backstop that keeps an absurd amount from
 * being recorded by any path (hand-typed digits, a paste, a scanner with no
 * Enter suffix).
 *
 * Flat caps only, per new input: no term depends on the expected drawer cash,
 * so the blind count stays blind and the renderer can run the same check
 * without being told anything. A pay-out has no cap here: the existing
 * drawer bound already refuses it generically (OD-278-4). The caps never
 * apply to an aggregate, so a shift recorded before rollout keeps working.
 *
 * Main (`shift-cashup-service.ts`) is the authority; the renderer shift
 * screens run the same pure rule as a pre-check. A code constant, not tenant
 * configuration. Fail closed: an unknown currency has a cap of 0.
 *
 * This is not the storage bound (`src/main/shift-cashup/shift-amount-bound.ts`,
 * 2⁵³ − 1 minor for EGP, ~9.0×10¹³ EGP), which protects the wire format.
 */
import type { CurrencyCode } from '../money.js';
import { maxCashReceivedMinor } from '../payments/cash-bound.js';

/** The shift inputs that carry a capped amount. */
export type ShiftAmountEntry = 'opening_float' | 'pay_in' | 'counted_cash';

/**
 * EGP 1,000,000.00 — OD-278-2. A legitimate close counts the whole drawer;
 * above this the cashier records a bank-drop pay-out first.
 */
const MAX_COUNTED_CASH_MINOR: Readonly<Record<CurrencyCode, number>> = {
  EGP: 100_000_000,
};

function maxCountedCashMinor(currency: string): number {
  return Object.hasOwn(MAX_COUNTED_CASH_MINOR, currency)
    ? MAX_COUNTED_CASH_MINOR[currency as CurrencyCode]
    : 0;
}

/**
 * The largest amount one shift input accepts, in minor units; 0 for an
 * unknown currency. The float and pay-in cap is D-F2's cash constant
 * (EGP 100,000.00, OD-278-1), so one owner decision moves both.
 */
export function maxShiftEntryMinor(entry: ShiftAmountEntry, currency: string): number {
  return entry === 'counted_cash' ? maxCountedCashMinor(currency) : maxCashReceivedMinor(currency);
}

/** True when a shift amount is within its input's flat cap. */
export function isShiftAmountWithinBound(
  entry: ShiftAmountEntry,
  amountMinor: number,
  currency: string,
): boolean {
  return amountMinor <= maxShiftEntryMinor(entry, currency);
}
