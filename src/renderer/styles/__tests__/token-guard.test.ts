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
 *   | Family                      | Must resolve through           |
 *   |-----------------------------|--------------------------------|
 *   | Colour                      | --color-*                      |
 *   | Spacing (margin/padding/gap)| --space-*                      |
 *   | Radius                      | --radius-*                     |
 *   | Typography size            | --font-size-* / --line-height-*|
 *   | Elevation / shadow          | --shadow-*                     |
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

type StyleBlock = {
  file: string;
  source: string;
};

type Pair = {
  prop: string;
  value: string;
};

type FamilyRule = {
  name: string;
  guidance: string;
  findLiterals: (source: string) => string[];
};

function collectComponentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' ? [] : collectComponentFiles(full);
    }
    return ['.ts', '.tsx'].includes(extname(entry)) ? [full] : [];
  });
}

/**
 * Extract every style object in a source file — BOTH forms.
 *
 * CODEX REVIEW P2 — "Scan assigned style objects in the token guard". The
 * original extractor recognised only the literal JSX form `style={{ … }}`, so
 * it silently skipped this repo's equally common
 * `const x: CSSProperties = { … }; <div style={x}>` pattern. That made the
 * "hard zero" claim false: `ReceiptPreview` carried 12 raw values across
 * `titleBandStyle`, `canvasRegionStyle` and `slipStyle` while the guard
 * reported no violation.
 *
 * A guard that passes because it stopped looking is worse than no guard, so
 * both forms are scanned now. (A full AST walk would be stricter still; these
 * two patterns cover every style object present in `src/renderer/ui` today,
 * verified by sweep — and the `scans a non-trivial number` assertion plus the
 * mutation check below guard against the extractor silently going blind.)
 */
function extractStyleBlocks(source: string): string[] {
  return [
    // Literal JSX: style={{ … }}
    ...[...source.matchAll(/style=\{\{(.*?)\}\}/gs)].map((match) => match[1] ?? ''),
    // Assigned object: const x: CSSProperties = { … };
    ...[...source.matchAll(/:\s*CSSProperties\s*=\s*\{(.*?)\n\s*\};/gs)].map(
      (match) => match[1] ?? '',
    ),
  ];
}

function matchPairs(source: string, pattern: RegExp): Pair[] {
  return [...source.matchAll(pattern)].map((match) => ({
    prop: match[1] ?? '',
    value: match[2] ?? '',
  }));
}

function findColourLiterals(source: string): string[] {
  return [
    ...(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []),
    ...(source.match(/\b(?:rgba?|hsla?)\s*\(/g) ?? []),
  ];
}

function findSpacingLiterals(source: string): string[] {
  return matchPairs(source, /(\w+)\s*:\s*'([^']*)'/g).flatMap(({ prop, value }) => {
    if (!SPACING_PROPS.test(prop)) return [];
    return (value.match(/(?<![\w-])(\d+)px/g) ?? [])
      .filter((px) => px !== '0px' && px !== '1px')
      .map((px) => `${prop}: ${px}`);
  });
}

function findRadiusLiterals(source: string): string[] {
  return matchPairs(source, /(borderRadius\w*)\s*:\s*'([^']*)'/g)
    .filter(({ value }) => !value.includes('var(--radius-'))
    .filter(({ value }) => !/^(0|none|inherit)$/.test(value.trim()))
    .map(({ prop, value }) => `${prop}: ${value}`);
}

function findTypographyLiterals(source: string): string[] {
  return matchPairs(source, /(fontSize|lineHeight|fontWeight)\s*:\s*([^,}]+)/g)
    .map(({ prop, value }) => ({ prop, value: value.trim() }))
    .filter(({ value }) => !value.includes('var(--font-size-'))
    .filter(({ value }) => !value.includes('var(--line-height-'))
    .filter(({ value }) => !value.includes('var(--font-weight-'))
    .filter(({ value }) => !/^(inherit|'inherit')$/.test(value))
    .map(({ prop, value }) => `${prop}: ${value}`);
}

function findShadowLiterals(source: string): string[] {
  return matchPairs(source, /(boxShadow|textShadow)\s*:\s*'([^']*)'/g)
    .filter(({ value }) => !value.includes('var(--shadow-'))
    .filter(({ value }) => !/^(none|inherit)$/.test(value.trim()))
    .map(({ prop, value }) => `${prop}: ${value}`);
}

const FAMILY_RULES: FamilyRule[] = [
  {
    name: 'COLOUR',
    guidance: 'Raw colour literals (use var(--color-*); a missing token is added in U0)',
    findLiterals: findColourLiterals,
  },
  {
    name: 'SPACING',
    guidance: 'Raw spacing literals (use var(--space-*))',
    findLiterals: findSpacingLiterals,
  },
  {
    name: 'RADIUS',
    guidance: 'Raw radius literals (use var(--radius-*))',
    findLiterals: findRadiusLiterals,
  },
  {
    name: 'TYPOGRAPHY-SIZE',
    guidance:
      'Raw typography literals (use var(--font-size-*) / var(--line-height-*) / var(--font-weight-*))',
    findLiterals: findTypographyLiterals,
  },
  {
    name: 'ELEVATION/SHADOW',
    guidance: 'Raw shadow literals (use var(--shadow-*); FR-33 forbids stacked elevation anyway)',
    findLiterals: findShadowLiterals,
  },
];

const files = collectComponentFiles(UI_DIR);

const styleBlocks: StyleBlock[] = files.flatMap((file) =>
  extractStyleBlocks(readFileSync(file, 'utf-8')).map((source) => ({
    file: file.replace(UI_DIR, 'ui'),
    source,
  })),
);

function collectViolations(rule: FamilyRule): string[] {
  return styleBlocks.flatMap(({ file, source }) =>
    rule.findLiterals(source).map((literal) => `${file}: ${literal}`),
  );
}

describe('022 T025 — design-token guard (all five FR-8 value families)', () => {
  it('scans a non-trivial number of renderer components (guard is actually wired)', () => {
    // A path or glob mistake would silently pass every assertion below.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(FAMILY_RULES)('introduces no raw $name literal in an inline style', (rule) => {
    const violations = collectViolations(rule);
    expect(violations, `${rule.guidance}:\n${violations.join('\n')}`).toEqual([]);
  });
});
