/**
 * UX-12 — the one set of human-facing formatters for renderer output.
 *
 * Rules (UX/UI Constitution UX-12):
 *  - Western digits everywhere (`ar-EG-u-nu-latn`, never Arabic-Indic);
 *  - money as `1,250.00 EGP` (grouped thousands, two decimals, `EGP` after;
 *    a negative amount starts with the minus sign U+2212 `−`, DESIGN.md numerals);
 *  - 24-hour clock;
 *  - counts with Western digits.
 *
 * Display only. Arithmetic stays integer minor units (`src/shared/money.ts`);
 * receipts are rendered by main and are NOT formatted here. Input values that
 * must round-trip through the strict parser (`formatMinorToInput`) stay
 * ungrouped and are deliberately outside this module.
 */

const DASH = '—';
const LOCALE = 'ar-EG-u-nu-latn';

/**
 * Integer minor units → `1,250.00 EGP`. Integer arithmetic only (no floats), so
 * large amounts never pick up binary-float noise. A non-safe integer renders as
 * an em dash rather than a wrong number.
 */
export function formatHumanMoney(minor: number): string {
  if (!Number.isSafeInteger(minor)) return DASH;
  const sign = minor < 0 ? '\u2212' : '';
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / 100);
  const cents = abs - major * 100;
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}.${String(cents).padStart(2, '0')} EGP`;
}

export interface HumanDateTimeOptions {
  /** Include the year (default false). */
  withYear?: boolean;
  /** Include the day/month (default true). */
  withDate?: boolean;
  /** Include the 24-hour clock (default true). */
  withTime?: boolean;
  /** Month style when a date is shown (default 'short'). */
  month?: 'short' | 'long';
}

/**
 * ISO instant → absolute Arabic date/time with Western digits and a 24-hour
 * clock. Returns null for an unparseable value so each caller keeps its own
 * fallback (verbatim text, dash, …).
 *
 * Time zone: the terminal's local zone. The renderer has no Store-timezone
 * source yet; that gap is tracked by RT-279 and UX-12 ("business time from
 * business context").
 */
export function formatHumanDateTime(iso: string, opts: HumanDateTimeOptions = {}): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const { withYear = false, withDate = true, withTime = true, month = 'short' } = opts;
  const parts: Intl.DateTimeFormatOptions = {};
  if (withYear) parts.year = 'numeric';
  if (withDate) {
    parts.month = month;
    parts.day = 'numeric';
  }
  if (withTime) {
    parts.hour = '2-digit';
    parts.minute = '2-digit';
    parts.hourCycle = 'h23';
  }
  return new Intl.DateTimeFormat(LOCALE, parts).format(date);
}

/** A count with Western digits (`1,234`). */
export function formatHumanCount(n: number): string {
  return new Intl.NumberFormat(LOCALE).format(n);
}
