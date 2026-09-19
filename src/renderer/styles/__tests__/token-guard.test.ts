import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * 022 T025 / T025a — design-token guard across ALL FIVE FR-8 value families.
 *
 * FR-8 and SC-1 name five families. A colour-only guard would leave four
 * unprotected and let the system drift exactly where v3.5's density and
 * rhythm decisions live, so all five are asserted:
 *
 *   | Family                      | Must resolve through          |
 *   |-----------------------------|-------------------------------|
 *   | Colour                      | --color-*                     |
 *   | Spacing (margin/padding/gap)| --space-*                     |
 *   | Radius                      | --radius-*                    |
 *   | Typography size             | --font-size-* / --line-height-*|
 *   | Elevation / shadow          | --shadow-*                    |
 *
 * SCOPE: inline `style={{ … }}` objects in renderer components. That is where
 * a raw value can be introduced by a single edit without review. Values in
 * `tailwind.css` itself are the token DEFINITIONS and are deliberately out of
 * scope — that file is the one place literals belong (022 standing constraint:
 * "those values change ONLY in :root / dark register token values").
 *
 * A needed literal means a MISSING TOKEN. The fix is to add the token in U0,
 * not to add a local value and not to widen the exception list below.
 *
 * ── T025a — the CLOSED structural exception list ──────────────────────────
 *
 * Some values are structural, not design-system values; tokenizing them would
 * be noise rather than consistency. The guard allows exactly these:
 *
 *   1. `0`, `100%`, `auto`, `inherit`, `none` — not design values.
 *   2. `1px` hairline borders/outlines — the rule WIDTH is structural; its
 *      COLOUR is still token-bound (77 `1px solid` occurrences exist today).
 *   3. Media-query breakpoints (1023px, 1279px, 1280px, 1180px, …) — viewport
 *      tier boundaries owned by `useViewportTier`, not the spacing scale.
 *   4. Component-intrinsic dimensions (width/height/flex-basis/grid-template,
 *      e.g. the 56px top bar, nav-rail widths) — layout geometry.
 *   5. The >=44x44 touch floor — a constitutional minimum (P14) with its own
 *      invariant test.
 *
 * This list is CLOSED. Adding to it is a deliberate, reviewed act — never a
 * way to silence a failing assertion. If this test fails, the answer is
 * almost always "add the missing token", not "extend the exceptions".
 */

const UI_DIR = resolve(__dirname, '../../ui');

/** Properties whose values must come from the spacing scale. */
const SPACING_PROPS =
  /^(margin|padding|gap|rowGap|columnGap|inset|top|right|bottom|left|marginBlock|marginInline|paddingBlock|paddingInline)/;

function collectComponentFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(current: string): void {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue;
        walk(full);
      } else if (['.ts', '.tsx'].includes(extname(entry))) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

/** Extract the body of every inline `style={{ … }}` object in a source file. */
function extractStyleBlocks(source: string): string[] {
  return [...source.matchAll(/style=\{\{(.*?)\}\}/gs)].map((m) => m[1] ?? '');
}

const files = collectComponentFiles(UI_DIR);

describe('022 T025 — design-token guard (all five FR-8 value families)', () => {
  it('scans a non-trivial number of renderer components (guard is actually wired)', () => {
    // A path or glob mistake would silently pass every assertion below.
    expect(files.length).toBeGreaterThan(20);
  });

  it('introduces no raw COLOUR literal in an inline style', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const block of extractStyleBlocks(source)) {
        // Hex, rgb()/rgba(), hsl()/hsla() — all must come from --color-*.
        const hits = [
          ...(block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []),
          ...(block.match(/\b(?:rgba?|hsla?)\s*\(/g) ?? []),
        ];
        for (const hit of hits) {
          violations.push(`${file.replace(UI_DIR, 'ui')}: ${hit}`);
        }
      }
    }
    expect(
      violations,
      `Raw colour literals (use var(--color-*); a missing token is added in U0):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('introduces no raw SPACING literal in an inline style', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const block of extractStyleBlocks(source)) {
        // Match `property: '<value>'` pairs and check only spacing properties,
        // so component-intrinsic width/height (exception 4) is not flagged.
        for (const m of block.matchAll(/(\w+)\s*:\s*'([^']*)'/g)) {
          const prop = m[1] ?? '';
          const value = m[2] ?? '';
          if (!SPACING_PROPS.test(prop)) continue;
          for (const px of value.match(/(?<![\w-])(\d+)px/g) ?? []) {
            // Exception 1 + 2: `0` and 1px hairlines are structural.
            if (px === '0px' || px === '1px') continue;
            violations.push(`${file.replace(UI_DIR, 'ui')}: ${prop}: ${px}`);
          }
        }
      }
    }
    expect(
      violations,
      `Raw spacing literals (use var(--space-*)):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('introduces no raw RADIUS literal in an inline style', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const block of extractStyleBlocks(source)) {
        for (const m of block.matchAll(/(borderRadius\w*)\s*:\s*'([^']*)'/g)) {
          const value = m[2] ?? '';
          const prop = m[1] ?? '';
          if (value.includes('var(--radius-')) continue;
          if (/^(0|none|inherit)$/.test(value.trim())) continue;
          violations.push(`${file.replace(UI_DIR, 'ui')}: ${prop}: ${value}`);
        }
      }
    }
    expect(
      violations,
      `Raw radius literals (use var(--radius-*)):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('introduces no raw TYPOGRAPHY-SIZE literal in an inline style', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const block of extractStyleBlocks(source)) {
        for (const m of block.matchAll(/(fontSize|lineHeight|fontWeight)\s*:\s*([^,}]+)/g)) {
          const prop = m[1] ?? '';
          const value = (m[2] ?? '').trim();
          if (value.includes('var(--font-size-')) continue;
          if (value.includes('var(--line-height-')) continue;
          if (value.includes('var(--font-weight-')) continue;
          if (/^(inherit|'inherit')$/.test(value)) continue;
          violations.push(`${file.replace(UI_DIR, 'ui')}: ${prop}: ${value}`);
        }
      }
    }
    expect(
      violations,
      `Raw typography literals (use var(--font-size-*) / var(--line-height-*) / var(--font-weight-*)):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('introduces no raw ELEVATION/SHADOW literal in an inline style', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      for (const block of extractStyleBlocks(source)) {
        for (const m of block.matchAll(/(boxShadow|textShadow)\s*:\s*'([^']*)'/g)) {
          const value = m[2] ?? '';
          const prop = m[1] ?? '';
          if (value.includes('var(--shadow-')) continue;
          if (/^(none|inherit)$/.test(value.trim())) continue;
          violations.push(`${file.replace(UI_DIR, 'ui')}: ${prop}: ${value}`);
        }
      }
    }
    expect(
      violations,
      `Raw shadow literals (use var(--shadow-*); FR-33 forbids stacked elevation anyway):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
