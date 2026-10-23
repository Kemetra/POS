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

/** Bidi embeddings, overrides and isolates (no reordering tricks), by code point. */
const BIDI_CONTROLS: ReadonlyArray<readonly [number, number]> = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const bidiClass = BIDI_CONTROLS.map(
  ([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`,
).join('');
/** Control characters and bidi controls. */
const UNPRINTABLE = new RegExp(`[\\p{Cc}${bidiClass}]`, 'gu');

/** Server or operator text made safe to print: control and bidi characters removed. */
export function stripUnprintable(raw: string): string {
  return raw.replace(UNPRINTABLE, '');
}

/** Width in printed columns: code points, never UTF-16 units (astral = 1). */
export function columnWidth(text: string): number {
  return Array.from(text).length;
}

/** A word to place; `glued` pieces continue a hard-split token and start a new line. */
interface Piece {
  readonly text: string;
  readonly glued: boolean;
}

/** A token longer than a continuation line, cut into pieces that fit. */
function splitToken(word: string): Piece[] {
  const chars = Array.from(word);
  if (chars.length <= CONTINUATION) return [{ text: word, glued: false }];
  const pieces: Piece[] = [];
  for (let i = 0; i < chars.length; i += CONTINUATION) {
    pieces.push({ text: chars.slice(i, i + CONTINUATION).join(''), glued: i > 0 });
  }
  return pieces;
}

/** Whether `word` must start a new line rather than join `current`. */
function startsNewLine(current: string, piece: Piece, onFirstLine: boolean): boolean {
  if (current === '') return false;
  // A glued piece never shares a line: a space there would alter the value.
  if (piece.glued) return true;
  const indent = onFirstLine ? 0 : INDENT.length;
  return columnWidth(`${current} ${piece.text}`) + indent > COLS;
}

/** Word-wrap to the roll by code points, with a hanging indent on continuations. */
export function wrapColumns(text: string): string[] {
  const pieces = text
    .split(' ')
    .filter((w) => w !== '')
    .flatMap(splitToken);
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (startsNewLine(current, piece, out.length === 0)) {
      out.push(current);
      current = piece.text;
    } else {
      current = current === '' ? piece.text : `${current} ${piece.text}`;
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
  if (columnWidth(clean) <= COLS) return [clean];
  const lines = wrapColumns(clean);
  return lines.length === 0 ? [''] : lines;
}
