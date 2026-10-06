/**
 * RT-17 follow-up (comment 10948, "JPY bound vs NUMERIC(19,4)") — the largest
 * shift amount the POS accepts, per currency.
 *
 * Backend-Core stores a shift amount in `NUMERIC(19,4)`, and the contract
 * allows 15 integer digits (`^-?[0-9]{1,15}(\.[0-9]{1,4})?$`). The POS keeps
 * minor units as safe integers (at most 2^53 − 1, 16 digits). With 2 or 3
 * minor-unit digits that range stays below 10^15 major units, but a currency
 * with none (JPY) would reach 9 007 199 254 740 991 yen, one digit too many:
 * a pay-in valid on its own could take the shift's expected cash past what the
 * close can send, and the shift could never be closed. The maximum is
 * therefore the smaller of the safe-integer range and 15 integer digits.
 *
 * Fail closed: a currency the POS has no exponent for has no maximum (0).
 */
import { knownExponentFor } from '../sales-sync/create-sale-sync-client.js';

/** The contract's (and `NUMERIC(19,4)`'s) integer digits of a shift amount. */
const INTEGER_DIGITS = 15;

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** The largest shift amount, in the currency's minor units; 0 for an unknown currency. */
export function maxShiftAmountMinor(currencyCode: string): number {
  const exponent = knownExponentFor(currencyCode);
  if (exponent === undefined) return 0;
  const byDigits = 10n ** BigInt(INTEGER_DIGITS + exponent) - 1n;
  return Number(byDigits < SAFE_MAX ? byDigits : SAFE_MAX);
}
