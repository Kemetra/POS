/**
 * RT-259 (UX-08) — numeric human-input normalization.
 *
 * A cashier on an Arabic keyboard layout types Arabic-Indic (U+0660..0669) or
 * Persian (U+06F0..06F9) digits. Numeric fields normalize them to ASCII 0-9 at
 * input time; display stays Western digits (DESIGN.md numerals).
 *
 * Only the Arabic DECIMAL separator (U+066B) is mapped to ".". Thousands
 * separators (U+066C, ",") are deliberately left alone so the existing
 * keystroke guard / strict money parser still reject them — money is never
 * silently reinterpreted.
 */

/** Arabic-Indic and Persian digits → ASCII. Does not trim. */
export function mapDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Arabic-Indic (U+0660..) and Persian (U+06F0..) digits → ASCII; trims. */
export function normalizeDigits(raw: string): string {
  return mapDigits(raw.trim());
}

/** `normalizeDigits` plus the Arabic decimal separator «٫» (U+066B) → ".". */
export function normalizeNumericInput(raw: string): string {
  return normalizeDigits(raw).replace(/٫/g, '.');
}
