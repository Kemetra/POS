import { formatHumanDateTime, formatHumanMoney } from '../../ui/format/human-format';
import { normalizeDigits } from '../../ui/forms/normalize-digits';
import { parseCurrencyToMinor } from '../../ui/payments/parse-currency-to-minor';

/**
 * RT-17 slice 4 part 3 — display and entry formatting for the shift screens
 * (DESIGN.md numerals: Western digits; inputs accept Arabic-Indic and Persian
 * digits). These format what main sent and parse what the operator typed;
 * they never compute a cash-up amount.
 */
const DASH = '—';

export function formatShiftMoney(minor: number, currencyCode = 'EGP'): string {
  if (currencyCode !== 'EGP' || !Number.isSafeInteger(minor)) return DASH;
  return formatHumanMoney(minor);
}

export function formatShiftTime(iso: string): string {
  return formatHumanDateTime(iso) ?? DASH;
}

export { normalizeDigits };

/** An entered amount in minor units (≥ 0, ≤ 2 decimals), or null. */
export function parseShiftAmount(raw: string): number | null {
  return parseCurrencyToMinor(normalizeDigits(raw));
}
