/**
 * Compare two strings by UTF-16 code unit — the order `Array.prototype.sort()`
 * uses with no compare function, written out so the intent is explicit.
 *
 * Use it where the order feeds a hash, a fingerprint or any other value that is
 * stored and compared later. `localeCompare` would make that order depend on
 * the runtime's ICU data and change values already on disk.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
