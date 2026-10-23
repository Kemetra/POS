/**
 * RT-204 — the shared "dynamic text reaches the roll" helpers, promoted from the
 * RT-15 S4 return slip so the sale receipt and the return slip wrap the same way.
 *
 * The roll is 42 columns. Width is counted in code points, never UTF-16 units
 * (an emoji is one column), and a token longer than a line is hard-wrapped, so
 * every printed line fits and nothing is clipped. Pure: no clock, no I/O.
 */

/** The receipt's column width, and what a wrapped continuation line can hold. */
export const COLS = 42;
const INDENT = '    ';
const CONTINUATION = COLS - INDENT.length;

/** Control characters and bidi embeddings/overrides/isolates (no reordering tricks). */
const UNPRINTABLE = /[\p{Cc}‪-‮⁦-⁩]/gu;

/** Server or operator text made safe to print: control and bidi characters removed. */
export function stripUnprintable(raw: string): string {
  return raw.replace(UNPRINTABLE, '');
}

/** Width in printed columns: code points, never UTF-16 units (astral = 1). */
export function columnWidth(text: string): number {
  return Array.from(text).length;
}

/** A token longer than a continuation line, cut into pieces that fit. */
function splitToken(word: string): string[] {
  const chars = Array.from(word);
  if (chars.length <= CONTINUATION) return [word];
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += CONTINUATION) {
    pieces.push(chars.slice(i, i + CONTINUATION).join(''));
  }
  return pieces;
}

/** Word-wrap to the roll by code points, with a hanging indent on continuations. */
export function wrapColumns(text: string): string[] {
  const words = text
    .split(' ')
    .filter((w) => w !== '')
    .flatMap(splitToken);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    const indent = out.length === 0 ? 0 : INDENT.length;
    if (current !== '' && columnWidth(candidate) + indent > COLS) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') out.push(current);
  return out.map((line, i) => (i === 0 ? line : `${INDENT}${line}`));
}

/**
 * A sale-receipt dynamic value as printable lines: made printable, then — only
 * when it does not already fit — wrapped. A value that fits prints verbatim, so
 * an ordinary receipt is byte-identical to before RT-204. Never empty: an empty
 * value is one empty line, as it always printed.
 */
export function receiptLines(text: string): string[] {
  const clean = stripUnprintable(text);
  return columnWidth(clean) <= COLS ? [clean] : wrapColumns(clean);
}
