// 009-product-search-and-barcode-lookup — `normalize.ts` (T006).
//
// The single, load-bearing folding function. The future catalogue-sourcing
// feature folds `name_fold` / `alias_fold` / `barcode_norm` with THIS function
// at write-time; the bridge folds the query with it at read-time. Matching is
// thus normalization-insensitive on both sides (FR-12b). The fold is
// IDEMPOTENT — folding an already-folded value is a no-op — which is what keeps
// the two sides in agreement.
//
// Fold rules (research §R4 / locked clarifications 2026-05-30):
//   • Arabic letters:  alef أ/إ/آ/ٱ → ا · alef-maqsura ى → ي · taa-marbuta ة → ه
//   • strip Arabic harakat (diacritics) + tatweel (ـ)
//   • English: lowercase + strip accents/diacritics (NFD → drop combining marks)
//   • Numerals: Arabic-Indic ٠–٩ → Latin 0–9
//   • Whitespace: trim + collapse internal runs to a single space

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'; // U+0660–U+0669, index = value

/**
 * Fold an Arabic / English / mixed string to its canonical search form.
 *
 * Pure and idempotent: `normalize(normalize(x)) === normalize(x)`.
 */
export function normalize(input: string): string {
  // 1. Decompose (NFD) so Latin accents AND the hamza/madda above precomposed
  //    alef variants (أ إ آ) split into base letter + combining mark...
  let out = input.normalize('NFD');

  // 2. ...then drop every combining mark. This removes Latin diacritics and
  //    Arabic harakat (all Nonspacing_Marks) in one pass, and reduces أ/إ/آ to ا.
  out = out.replace(/\p{M}/gu, '');

  // 3. Remove tatweel (kashida) — a letter-joining filler with no search value.
  out = out.replace(/ـ/g, '');

  // 4. Fold the remaining Arabic letter variants that do NOT decompose under NFD.
  out = out
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ → ا (آ/أ/إ are belt-and-braces after step 2)
    .replace(/ى/g, 'ي') // ى alef-maqsura → ي yaa
    .replace(/ة/g, 'ه'); // ة taa-marbuta → ه heh

  // 5. Lowercase (English; a no-op on Arabic).
  out = out.toLowerCase();

  // 6. Fold Arabic-Indic digits ٠–٩ to Latin 0–9.
  out = out.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC_DIGITS.indexOf(d)));

  // 7. Trim and collapse internal whitespace runs to a single space.
  out = out.replace(/\s+/g, ' ').trim();

  return out;
}
