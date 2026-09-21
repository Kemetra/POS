import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * 022 hard reset — per-screen rebuild vocabulary guard.
 *
 * ── WHAT THIS DEFENDS ─────────────────────────────────────────────────────
 *
 * `component-layer-discipline.test.ts` fixed WHICH rules win the cascade. It
 * did not retire the v3.5 vocabulary, and that distinction is the whole reason
 * the incremental attempt still read as "old POS with new colours":
 *
 *   - 333 of the renderer's live classes are defined in `tailwind.css`.
 *   - Only ~96 are shared primitives (`btn`, `panel`, `input-field`, …).
 *   - ~237 are per-screen geometry classes (`sign-in-route__*`,
 *     `payment-surface__*`, `cart-pane__*`) authored one screen at a time.
 *
 * Deep BEM element classes hard-code geometry INTO the screen. Restyling
 * `.sign-in-route__pin-section` cannot change where the PIN pad sits, because
 * its position is the class's reason to exist. So a screen is only genuinely
 * rebuilt once it stops naming that vocabulary at all and composes from the
 * shared `.v4-*` layout layer instead.
 *
 * ── WHY A GUARD AND NOT JUST A SCREENSHOT ─────────────────────────────────
 *
 * Visual acceptance for this feature is a MANUAL owner capture (the repo has
 * no Playwright/Puppeteer and `screenshots/README.md` forbids adding one), so
 * nothing in CI can see the rendered pixels. This guard is the mechanical half:
 * it cannot prove a screen looks right, but it CAN prove the old geometry is
 * gone and did not creep back. Those are different claims and this file only
 * makes the second one.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT FORBID ────────────────────────────────
 *
 * Component-level primitives survive on purpose. `.pin-pad__*` and
 * `.roster-list__*` are pinned BY NAME with accessibility requirements in
 * `ui/operator/__tests__/v4-sign-in-presentation.test.ts`, and `PinPad` carries
 * the PR-1 guarantee that PIN digits never enter the DOM. Deleting those to
 * chase a zero-legacy-class score would destroy working, security-relevant
 * components to satisfy a metric. The target is SCREEN GEOMETRY, not every
 * class a screen happens to touch.
 */

const ROOT = resolve(__dirname, '../../');
const CSS = readFileSync(resolve(ROOT, 'styles/tailwind.css'), 'utf-8');

/**
 * Screens rebuilt onto the v4 layout vocabulary, with the screen-geometry
 * class prefixes each one retired. Add a row when a screen is rebuilt; the
 * remaining screens are tracked as outstanding in the slice report, not here
 * (a guard that asserts unfinished work fails for the wrong reason).
 */
const REBUILT_SCREENS: ReadonlyArray<{
  readonly screen: string;
  readonly file: string;
  readonly retired: ReadonlyArray<string>;
}> = [
  {
    screen: 'sign-in',
    file: 'routes/sign-in.tsx',
    retired: ['sign-in-route', 'sign-in-pane', 'sign-in-split'],
  },
  {
    // Renders INSIDE the rebuilt sign-in screen, so it is part of that screen's
    // surface. Listing it separately keeps the guard honest: a v4 shell wrapping
    // a v3.5 form is not a rebuilt screen, and omitting this row would have let
    // the guard report sign-in clean while `.sign-in-form__*` still composed it.
    screen: 'sign-in › manager/admin form',
    file: 'ui/operator/ManagerAdminSignInForm.tsx',
    retired: ['sign-in-form'],
  },
];

/** Strip block comments so prose naming a retired class is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every class token appearing in a `className="..."` literal. */
function classNamesIn(source: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(/className="([^"]+)"/g)) {
    for (const token of (match[1] ?? '').split(/\s+/)) {
      if (token.length > 0) found.add(token);
    }
  }
  return found;
}

describe('022 hard reset — rebuilt screens use the v4 vocabulary', () => {
  for (const { screen, file, retired } of REBUILT_SCREENS) {
    describe(screen, () => {
      const path = resolve(ROOT, file);

      it('the screen source exists', () => {
        expect(existsSync(path), `${file} not found`).toBe(true);
      });

      it('names no retired screen-geometry class in its markup', () => {
        const used = classNamesIn(readFileSync(path, 'utf-8'));
        const violations = [...used].filter((cls) =>
          retired.some((prefix) => cls === prefix || cls.startsWith(`${prefix}__`)),
        );
        expect(
          violations,
          `${file} still composes from retired v3.5 geometry: ${violations.join(', ')}.\n` +
            'Compose from the shared `.v4-*` layout layer instead — restyling a ' +
            'per-screen BEM class cannot change the layout it encodes.',
        ).toEqual([]);
      });

      it('composes from the shared v4 layout layer', () => {
        const used = classNamesIn(readFileSync(path, 'utf-8'));
        const v4 = [...used].filter((cls) => cls.startsWith('v4-'));
        expect(
          v4.length,
          `${file} references no \`.v4-*\` class, so it is not rebuilt onto the ` +
            'shared layout vocabulary.',
        ).toBeGreaterThan(0);
      });

      it('leaves no orphan rules for the retired classes in the stylesheet', () => {
        const orphans = retired.filter((prefix) =>
          new RegExp(`^\\s*\\.${prefix}(__[a-z-]+)?[\\s,{:]`, 'm').test(stripComments(CSS)),
        );
        expect(
          orphans,
          `tailwind.css still defines retired geometry: ${orphans.join(', ')}.\n` +
            'Dead screen CSS is how a superseded layout returns — delete it with the screen.',
        ).toEqual([]);
      });
    });
  }
});

describe('022 hard reset — the v4 layout layer is present and layered', () => {
  it('defines the core v4 layout primitives', () => {
    for (const cls of ['.v4-screen', '.v4-columns', '.v4-panel', '.v4-stack', '.v4-choice']) {
      expect(CSS, `${cls} is missing from the stylesheet`).toContain(`${cls} {`);
    }
  });

  it('declares v4 geometry with logical properties, not physical ones', () => {
    // RTL-native: the terminal is Arabic-first. A physical `left`/`right` in the
    // layout layer would silently mirror wrong under `dir="rtl"`.
    const layer = CSS.slice(CSS.indexOf('.v4-screen {'));
    const physical = layer.match(/^\s*(margin|padding|border)-(left|right)\s*:/gm) ?? [];
    expect(
      physical,
      `v4 layout layer uses physical direction properties: ${physical.join(', ')}`,
    ).toEqual([]);
  });

  it('resolves v4 colour through tokens, never raw literals', () => {
    const layer = CSS.slice(CSS.indexOf('.v4-screen {'));
    const literals = layer.match(/:\s*#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(literals, `v4 layout layer pins raw colour literals: ${literals.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * ── A STATE ATTRIBUTE MUST HAVE A STYLE THAT ANSWERS IT ─────────────────
   *
   * A rebuild retires per-screen BEM classes, and a state selector written
   * against a retired class dies with it while the attribute that triggers it
   * survives in the markup. The result is a state the code believes it is
   * signalling and the operator never sees.
   *
   * That happened here: the rebuild deleted
   * `.sign-in-route__pin-section[data-error]` — the wrong-PIN halo — while
   * `data-error` stayed on the rebuilt PIN container, so a refused PIN styled
   * nothing. A dangling attribute is worse than no attribute, because it reads
   * as working state to the next reader.
   *
   * Cheap, general invariant: every `data-*` STATE attribute set in a rebuilt
   * screen's markup must be answered by at least one attribute selector in the
   * stylesheet. `data-testid` is excluded (test seam, never styled), as are
   * attributes consumed as props rather than as CSS state.
   */
  it('answers every state attribute the rebuilt screens set', () => {
    /**
     * Attributes that are data, not style state.
     *
     * `data-testid` is a test seam. `data-category` marks WHICH refusal
     * occurred for tests and telemetry — the element already carries
     * `.v4-feedback__error` for its treatment, and the categories are
     * deliberately styled alike (a refusal reads the same however it arose).
     * Both are exposed for reading, never for selecting.
     */
    const IGNORED = new Set(['data-testid', 'data-theme', 'data-category']);
    const unanswered: string[] = [];

    for (const { screen, file } of REBUILT_SCREENS) {
      const source = readFileSync(resolve(ROOT, file), 'utf-8');
      const attributes = new Set(source.match(/\bdata-[a-z][a-z0-9-]*(?==)/g) ?? []);
      for (const attribute of attributes) {
        if (IGNORED.has(attribute)) continue;
        // Comments are stripped first: the prose explaining a state selector
        // must not count as the selector. (Caught by negative-testing this
        // guard — it passed against a stylesheet whose rule had been renamed,
        // because the comment above the rule still named the attribute.)
        if (!stripComments(CSS).includes(`[${attribute}`)) {
          unanswered.push(`${screen}: ${attribute}`);
        }
      }
    }

    expect(
      unanswered,
      'State attributes are set in markup but no stylesheet rule selects them.\n\n' +
        'Each is a state the screen believes it signals and the operator never sees —\n' +
        'usually a state selector that died with a retired per-screen class.\n\n' +
        `${unanswered.join('\n')}\n`,
    ).toEqual([]);
  });
});
