import { format as formatMoney, of as moneyOf } from '../../../shared/money';
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
  return formatMoney(moneyOf(minor, 'EGP'));
}

const TIME_FORMAT = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatShiftTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? DASH : TIME_FORMAT.format(date);
}

export { normalizeDigits };

/** An entered amount in minor units (≥ 0, ≤ 2 decimals), or null. */
export function parseShiftAmount(raw: string): number | null {
  return parseCurrencyToMinor(normalizeDigits(raw));
}
