/** Shared by the 42-column wrap tests (RT-204, RT-828, RT-829): what a printed slip's lines are. */

import { expect } from 'vitest';

export const COLS = 42;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The test's own East Asian Wide / Fullwidth ranges: an oracle independent of the production table.
const WIDE =
  /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1B000}-\u{1B2FB}\u{20000}-\u{3FFFD}]/u;
const EMOJI_CELLS = /\p{Emoji_Presentation}|[\uFE0F\u20E3]/u;
/** Marks, joiners and variation selectors: they never open a printed line. */
const CLUSTER_TAIL = /^(?:[\p{Mn}\p{Me}]|\u200D)/u;

/** Display cells a printed line takes on the roll: wide and emoji graphemes are 2, the rest 1. */
export function width(s: string): number {
  let cells = 0;
  for (const { segment } of segmenter.segment(s)) {
    cells += WIDE.test(segment) || EMOJI_CELLS.test(segment) ? 2 : 1;
  }
  return cells;
}

/** True when a line starts with a combining mark, joiner or variation selector (a split cluster). */
export const startsMidCluster = (line: string): boolean => CLUSTER_TAIL.test(line.trimStart());

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&' };

export function htmlLines(html: string): string[] {
  const band = /<div class="(?:band|rule)[^"]*"[^>]*>([^<]*)<\/div>/g;
  return Array.from(html.matchAll(band), (m) =>
    (m[1] ?? '').replace(/&(?:lt|gt|quot|amp);/g, (e) => ENTITIES[e] ?? e),
  );
}

const ESC = String.fromCodePoint(0x1b);
const GS = String.fromCodePoint(0x1d);
const NUL = String.fromCodePoint(0);
// ESC @ (init), ESC a n / ESC E n (align, emphasis), GS V NUL (cut): printer commands, not text.
const ESCPOS_COMMANDS = new RegExp(`${ESC}@|${ESC}[aE][^]|${GS}V${NUL}`, 'g');

export function escposLines(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).replace(ESCPOS_COMMANDS, '').split('\n');
}

export const compact = (lines: string[]): string => lines.join('').replace(/\s+/g, '');

/** An unbroken 120-character value in each script. */
export const VALUES: ReadonlyArray<readonly [string, string]> = [
  ['ASCII', 'A'.repeat(120)],
  ['emoji', '😀'.repeat(120)],
  ['Arabic', 'م'.repeat(120)],
];

/**
 * RT-829: values whose display width differs from their code-point count. Each is
 * at most 120 code points (the return slip's line-name cap) and wider than the roll.
 */
export const WIDE_VALUES: ReadonlyArray<readonly [string, string]> = [
  ['CJK wide', '中'.repeat(80)],
  ['angle brackets U+2329', '\u2329'.repeat(30)],
  ['Kana Supplement U+1B000', '\u{1B000}'.repeat(30)],
  ['Yijing hexagrams U+4DC0', '\u4DC0'.repeat(30)],
  ['fullwidth Latin', 'Ａ'.repeat(80)],
  ['CJK words with spaces', '双 中文 '.repeat(15)],
  ['combining marks', 'é'.repeat(40)],
  ['ZWJ family emoji', '\u{1F468}‍\u{1F469}‍\u{1F467}'.repeat(20)],
  ['flag pairs', '\u{1F1EA}\u{1F1EC}'.repeat(30)],
  ['VS16 heart', '❤️'.repeat(40)],
  ['keycap without VS16', '1\u20E3'.repeat(30)],
  ['keycap', '1️⃣'.repeat(30)],
];

const clusterCount = (s: string): number => Array.from(segmenter.segment(s)).length;

/** What every wide-value test asserts of a printed slip's lines. */
export function expectFitsRoll(lines: string[], value: string): void {
  for (const line of lines) {
    expect(width(line), line).toBeLessThanOrEqual(COLS);
    expect(startsMidCluster(line), `cluster split before: ${line}`).toBe(false);
  }
  const flat = compact(lines);
  expect(flat).toContain(value.replace(/\s+/g, ''));
  // A break inside a cluster merges back when the lines are joined, so it shows as fewer clusters.
  const perLine = lines.reduce((n, line) => n + clusterCount(line.replace(/\s+/g, '')), 0);
  expect(perLine, 'a cluster was split across lines').toBe(clusterCount(flat));
}
