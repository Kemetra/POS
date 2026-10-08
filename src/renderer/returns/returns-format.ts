import { formatHumanDateTime, formatHumanMoney } from '../ui/format/human-format';

/**
 * RT-15 S3 — display formatting for the return flow (DESIGN.md numerals).
 *
 * Western digits everywhere, 24-hour clock (UX-12). Money goes through the
 * shared integer-minor `formatHumanMoney`; anything that is not a safe integer in the one supported
 * currency renders as a dash rather than a wrong number. These format what
 * main sent; they never compute an amount.
 */
const DASH = '—';

export function formatReturnMoney(minor: number, currencyCode: string): string {
  if (currencyCode !== 'EGP' || !Number.isSafeInteger(minor)) return DASH;
  return formatHumanMoney(minor);
}

/** Arabic-Indic (U+0660..) and Persian (U+06F0..) digits → ASCII. */
export function normalizeSaleNumber(raw: string): string {
  return raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Absolute local time with Western digits (the pinned DESIGN.md locale). */
export function formatReturnTime(iso: string): string {
  return formatHumanDateTime(iso, { withYear: true }) ?? DASH;
}
