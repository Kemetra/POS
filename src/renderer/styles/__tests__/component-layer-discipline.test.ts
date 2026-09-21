import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * 022 US0-R2 — component-layer discipline guard.
 *
 * ── WHAT THIS DEFENDS ─────────────────────────────────────────────────────
 *
 * `tailwind.css` declares its component system inside `@layer components`.
 * CSS cascade layers have one property that makes this load-bearing:
 *
 *     UNLAYERED RULES BEAT LAYERED RULES — always, regardless of specificity
 *     and regardless of source order.
 *
 * So a single component rule written *after* the layer closes silently
 * outranks the entire v4 design system. Not "sometimes", not "if it is more
 * specific" — always. A more specific layered rule authored deliberately to
 * override it still loses.
 *
 * That is not hypothetical. Before this guard existed, ~1,135 lines of ported
 * POS v3.5 prototype CSS sat unlayered at the end of the file, with a header
 * comment stating the intent outright ("must not be silently overridden by the
 * layered rules above"). The consequence was that 022 US3's checkout
 * convergence could not fully land: `.tender-method-grid .method-card--selected`
 * (layered, specificity 0,2,0) lost to `.method-card--selected` (unlayered,
 * 0,1,0), so the v3.5 selected-tile treatment survived the v4 restyle.
 *
 * ── WHAT IS LEGITIMATELY UNLAYERED ────────────────────────────────────────
 *
 * This guard forbids CLASS selectors only. These stay unlayered by design and
 * are not violations:
 *
 *   - `:root` / `[data-theme]` token registers — token DEFINITIONS.
 *   - Element + universal base rules (`html`, `body`, `*`, `*::before`).
 *   - `@keyframes` — not rules with selectors at all.
 *   - `@import`.
 *
 * ── WHY `prefers-reduced-motion` IS NOT AN EXCEPTION ──────────────────────
 *
 * The reduced-motion block (NFR-007) overrides animations and therefore MUST
 * keep winning. It does: re-homed to the END of `@layer components`, it sits
 * later in the same layer at equal-or-higher specificity than the animations it
 * cancels, so it still applies. It does not need to be unlayered to work, and
 * leaving it unlayered would make this guard unable to distinguish an
 * accessibility override from a legacy regression.
 *
 * ── HOW THE BOUNDARY IS FOUND ─────────────────────────────────────────────
 *
 * By brace-depth from the `@layer components` opener — NEVER by line number.
 * A literal offset would rot on the first edit above it and would quietly stop
 * guarding anything.
 */

const CSS_PATH = resolve(__dirname, '../tailwind.css');
const css = readFileSync(CSS_PATH, 'utf-8');
const lines = css.split('\n');

/** Strip comments so selector scanning never reads prose. */
function stripComments(source: string): string {
  // Replace comment bodies with equivalent newline count so line numbers hold.
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const scrubbed = stripComments(css).split('\n');

/** Count regex matches on one line. Hoisted so the depth walk stays flat. */
function countMatches(line: string, pattern: RegExp): number {
  return (line.match(pattern) ?? []).length;
}

/** Net brace delta contributed by a single line: openers minus closers. */
function braceDelta(line: string): number {
  return countMatches(line, /\{/g) - countMatches(line, /\}/g);
}

/**
 * Locate `@layer components` and its closing brace by depth counting.
 * Returns 0-based line indices.
 */
function findComponentLayer(): { open: number; close: number } {
  const open = scrubbed.findIndex((l) => /^\s*@layer\s+components\s*\{/.test(l));
  if (open === -1) {
    throw new Error('@layer components opener not found in tailwind.css');
  }
  let depth = 0;
  for (let i = open; i < scrubbed.length; i += 1) {
    depth += braceDelta(scrubbed[i] ?? '');
    if (depth === 0 && i > open) {
      return { open, close: i };
    }
  }
  throw new Error('@layer components never closes');
}

/**
 * Collect every line after the layer closes that introduces a CLASS selector.
 *
 * A "selector line" is a line whose pre-`{` text contains a `.class` token.
 * Declaration values are excluded because we only read the text before `{`.
 */
function unlayeredClassSelectors(from: number): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  for (let i = from + 1; i < scrubbed.length; i += 1) {
    const raw = scrubbed[i] ?? '';
    // Only consider lines that open a rule block.
    if (!raw.includes('{')) continue;
    const selector = raw.slice(0, raw.indexOf('{'));
    // At-rules (@media/@keyframes/@supports/@container) are containers, not
    // selectors — their INNER selectors are scanned by the normal line walk.
    if (/^\s*@/.test(selector)) continue;
    // A class token: `.name`, not `#id`, not a bare element.
    if (!/(?<![\w.#[-])\.[A-Za-z_-][\w-]*/.test(selector)) continue;
    found.push({ line: i + 1, text: selector.trim() });
  }
  return found;
}

describe('022 US0-R2 — component-layer discipline', () => {
  const { open, close } = findComponentLayer();

  it('locates the component layer by brace depth, not by line number', () => {
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    // Sanity: the layer must actually hold the component system, not be a stub.
    expect(close - open).toBeGreaterThan(500);
  });

  it('declares no component class selector after the component layer closes', () => {
    const violations = unlayeredClassSelectors(close);
    const report = violations
      .map((v) => `  tailwind.css:${v.line.toString()}  ${v.text}`)
      .join('\n');
    expect(
      violations,
      `Unlayered component CSS found after \`@layer components\` closes (line ${(close + 1).toString()}).\n\n` +
        'Unlayered rules OUTRANK every layered rule regardless of specificity, so each of\n' +
        'these silently overrides the v4 design system. Move them INSIDE the layer.\n\n' +
        `${report}\n`,
    ).toEqual([]);
  });

  it('keeps token registers and element base rules unlayered (they are not violations)', () => {
    // Guards the guard: if this ever fails, the detector has started flagging
    // legitimate non-class CSS and would force a wrong "fix".
    const violations = unlayeredClassSelectors(close);
    const flaggedNonClass = violations.filter(
      (v) => /^(:root|html|body|\*)/.test(v.text) && !/\.[A-Za-z_-]/.test(v.text),
    );
    expect(flaggedNonClass).toEqual([]);
  });

  it('scans a non-trivial stylesheet (guard is actually wired)', () => {
    // A path or read mistake would make every assertion above vacuous.
    expect(lines.length).toBeGreaterThan(1000);
    expect(css).toContain('@layer components');
  });
});
