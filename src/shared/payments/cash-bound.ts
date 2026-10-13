/**
 * RT-437 (D-F2, plan `docs/design/vnext/16-d-f2-cash-received-bound.md`,
 * owner decisions RT-248) — the plausibility bound on cash received.
 *
 * F-02: a 13-digit barcode scanned or typed into the cash amount was read as
 * major units and recorded as ~6.2×10¹⁴ minor, with the same as change. The
 * RT-239 scan guard stops a burst in the UI; this rule is the backstop that
 * keeps an absurd amount from being recorded by any path.
 *
 * Rule: `amount ≤ max(maxCashReceivedMinor(currency), remaining)`, where
 * `remaining` is what the attempt still owes when the line is applied. The
 * `remaining` term lets a balance above the cap be paid exactly; above it, an
 * overpay is refused and the cashier enters the exact amount.
 *
 * Main (`tender-line-fsm.ts`) is the authority; the renderer (`CashEntry`)
 * runs the same pure rule as a pre-check. A code constant, not tenant
 * configuration. Fail closed: an unknown currency has a cap of 0, so only an
 * amount up to the remaining balance is accepted.
 */
import type { CurrencyCode } from '../money.js';

/** EGP 100,000.00 — owner decision 1 (RT-248). */
const MAX_CASH_RECEIVED_MINOR: Readonly<Record<CurrencyCode, number>> = {
  EGP: 10_000_000,
};

/** The operational maximum for one cash line, in minor units; 0 for an unknown currency. */
export function maxCashReceivedMinor(currency: string): number {
  return Object.prototype.hasOwnProperty.call(MAX_CASH_RECEIVED_MINOR, currency)
    ? MAX_CASH_RECEIVED_MINOR[currency as CurrencyCode]
    : 0;
}

/** True when a cash amount is within the bound for the balance still owed. */
export function isCashAmountWithinBound(
  amountMinor: number,
  remainingMinor: number,
  currency: string,
): boolean {
  return amountMinor <= Math.max(maxCashReceivedMinor(currency), remainingMinor);
}
