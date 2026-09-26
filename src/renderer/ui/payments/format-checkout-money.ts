import { format as formatMoney, of as moneyOf } from '../../../shared/money.js';

/**
 * RT-23 — the one display formatter for checkout amounts.
 *
 * Integer minor units → `N.NN EGP` through the shared `money.format`, so
 * checkout matches the amount due and the V5 Sale. A non-safe integer renders
 * as an em dash rather than a wrong number.
 */
export function formatCheckoutMoney(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    return '—';
  }
  return formatMoney(moneyOf(minor, 'EGP'));
}
