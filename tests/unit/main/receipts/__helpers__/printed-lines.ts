/** Shared by the 42-column wrap tests (RT-204, RT-828): what a printed slip's lines are. */

export const COLS = 42;

/** Width in printed columns: code points, never UTF-16 units. */
export const width = (s: string): number => Array.from(s).length;

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
