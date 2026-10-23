/**
 * RT-204 — the shared "dynamic text reaches the roll" helpers, promoted from the
 * RT-15 S4 return slip so the sale receipt and the return slip wrap the same way.
 *
 * The roll is 42 columns. Width is counted in display cells (RT-829): East Asian
 * wide and emoji clusters take two, combining marks none, and a cluster is never
 * split. A token longer than a line is hard-wrapped, so every printed line fits
 * and nothing is clipped. Pure: no clock, no I/O.
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

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** East Asian Wide / Fullwidth blocks (UAX #11 W and F), as code point ranges. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];
const isWide = (cp: number): boolean => WIDE_RANGES.some(([from, to]) => cp >= from && cp <= to);

/** Presents as an emoji (two cells): default emoji presentation, or forced by VS16 (U+FE0F). */
const EMOJI_CELLS = /\p{Emoji_Presentation}|\uFE0F/u;

/** Cells one grapheme cluster takes: wide and emoji clusters 2, a base with its marks 1. */
function clusterWidth(cluster: string): number {
  if (EMOJI_CELLS.test(cluster)) return 2;
  for (const ch of cluster) if (isWide(ch.codePointAt(0) ?? 0)) return 2;
  return 1;
}

/** Grapheme clusters of `text`: marks, joiners and variation selectors stay with their base. */
function clusters(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Width in printed columns: display cells per grapheme cluster, never code points or UTF-16 units. */
export function columnWidth(text: string): number {
  return clusters(text).reduce((cells, c) => cells + clusterWidth(c), 0);
}

/** A word to place; `glued` pieces continue a hard-split token and start a new line. */
interface Piece {
  readonly text: string;
  readonly glued: boolean;
  /** The spaces that preceded this word in the value (kept verbatim inside a line). */
  readonly gap: string;
}

/** A token longer than a continuation line, cut on cluster boundaries into pieces that fit. */
function splitToken(word: string, gap: string): Piece[] {
  if (columnWidth(word) <= CONTINUATION) return [{ text: word, glued: false, gap }];
  const pieces: Piece[] = [];
  let chunk = '';
  let cells = 0;
  for (const cluster of clusters(word)) {
    const w = clusterWidth(cluster);
    if (cells + w > CONTINUATION) {
      pieces.push({ text: chunk, glued: pieces.length > 0, gap: pieces.length > 0 ? '' : gap });
      chunk = '';
      cells = 0;
    }
    chunk += cluster;
    cells += w;
  }
  pieces.push({ text: chunk, glued: pieces.length > 0, gap: pieces.length > 0 ? '' : gap });
  return pieces;
}

/** Whether `piece` must start a new line rather than join `current`. */
function startsNewLine(current: string, piece: Piece, onFirstLine: boolean): boolean {
  if (current === '') return false;
  // A glued piece never shares a line: a space there would alter the value.
  if (piece.glued) return true;
  const indent = onFirstLine ? 0 : INDENT.length;
  return columnWidth(`${current}${piece.gap}${piece.text}`) + indent > COLS;
}

/** Words with the run of spaces before each; leading and trailing spaces are not content. */
function wordsWithGaps(text: string): Array<readonly [string, string]> {
  const words: Array<readonly [string, string]> = [];
  for (const m of text.matchAll(/( *)([^ ]+)/g))
    words.push([m[2] ?? '', words.length === 0 ? '' : (m[1] ?? '')]);
  return words;
}

/**
 * Word-wrap to the roll by display cells, with a hanging indent on continuations.
 * Runs of spaces inside a line print verbatim (as they do for a value that fits);
 * the gap at a break is dropped, as on any roll.
 */
export function wrapColumns(text: string): string[] {
  const pieces = wordsWithGaps(text).flatMap(([word, gap]) => splitToken(word, gap));
  const out: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (startsNewLine(current, piece, out.length === 0)) {
      out.push(current);
      current = piece.text;
    } else {
      current = current === '' ? piece.text : `${current}${piece.gap}${piece.text}`;
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
