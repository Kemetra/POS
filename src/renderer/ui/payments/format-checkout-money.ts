import { formatHumanMoney } from '../format/human-format';

/**
 * RT-23 — the one display formatter for checkout amounts.
 *
 * Integer minor units → `1,250.00 EGP` through the shared UX-12 human formatter,
 * so checkout matches the amount due and the V5 Sale. A non-safe integer renders
 * as an em dash rather than a wrong number.
 */
export function formatCheckoutMoney(minor: number): string {
  return formatHumanMoney(minor);
}
