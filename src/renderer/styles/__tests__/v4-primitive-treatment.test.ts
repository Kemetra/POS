import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * 022 T029–T033 — v4.0 shared-primitive treatment.
 *
 * These are STRUCTURAL assertions, not pixel diffs (022 tasks §Conventions:
 * "for visual work the RED/GREEN pair is a structural assertion — Arabic copy
 * present, token used, exactly one primary action").
 *
 * The point they defend: primitives must resolve their colour through the
 * token layer, so a palette retune in `:root` re-themes every surface without
 * touching a component. That is what makes U0 a foundation rather than a
 * sweep, and what stops per-screen "teal drift" (plan R7).
 */

const STYLES_DIR = resolve(__dirname, '..');
const css = readFileSync(resolve(STYLES_DIR, 'tailwind.css'), 'utf-8');

/** Extract a single rule body by exact selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('022 T029 — Button: primary / secondary / destructive treatment', () => {
  it('primary is a token-driven FILL (FR-4: teal may fill large primary actions)', () => {
    const body = rule('.btn--primary');
    expect(body).toMatch(/background-color:\s*var\(--color-primary\)/);
    expect(body).toMatch(/color:\s*var\(--color-primary-on\)/);
    // No literal may pin the fill — the retune must reach it.
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('destructive is visually separated and NEVER carries the primary treatment (FR-17)', () => {
    const body = rule('.btn--destructive');
    expect(body).toMatch(/background-color:\s*var\(--color-danger\)/);
    // The decisive check: destructive must not borrow the primary token.
    expect(body).not.toMatch(/var\(--color-primary/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('secondary is a quiet surface treatment, not a second filled primary (FR-14/FR-38)', () => {
    const body = rule('.btn--secondary');
    expect(body).toMatch(/background-color:\s*var\(--color-surface\)/);
    expect(body).not.toMatch(/background-color:\s*var\(--color-primary\)/);
  });
});

describe('022 T033 — focus-visible remains visible on the new light surfaces (NFR-2)', () => {
  it('the global :focus-visible rule uses the focus-ring token', () => {
    const body = rule(':focus-visible');
    expect(body).toMatch(/outline:.*var\(--color-focus-ring\)/);
    expect(body).toMatch(/outline-offset/);
  });

  it('--color-focus-ring resolves to the primary token (teal), not a literal', () => {
    expect(css).toMatch(/--color-focus-ring:\s*var\(--color-primary\)/);
  });
});

describe('022 T023/T024 — the v4.0 palette is installed in BOTH registers', () => {
  it('light register primary is the pharmacy green-teal, not the superseded navy', () => {
    const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(root).toMatch(/--color-primary:\s*#0f766e/);
    // The v3.5 navy and blue-cyan accent must be gone from the primary ramp.
    expect(root).not.toMatch(/--color-primary:\s*#1f4e7a/);
    expect(root).not.toMatch(/--color-accent:\s*#2e7da3/);
  });

  it('dark register is RETUNED to the same teal identity (T024 option (a))', () => {
    const dark = css.match(/:root\[data-theme=['"]dark['"]\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(dark).toMatch(/--color-primary:\s*#14b8a6/);
    // Not two identities: the superseded dark navy-blue must be gone.
    expect(dark).not.toMatch(/--color-primary:\s*#3b7ab2/);
  });
});

describe('022 T026 — Arabic-first typography', () => {
  it('the sans stack leads with Dubai and carries no unresolvable Inter face', () => {
    const value = css.match(/--font-family-sans\s*:\s*([^;]+);/)?.[1] ?? '';
    expect(value).toMatch(/^'Dubai'/);
    expect(value).not.toMatch(/Inter/i);
  });

  it('no @font-face RULE is introduced (no bundled or downloaded face)', () => {
    // Match the at-rule (followed by a block), not the token's own prose —
    // the comment above --font-family-sans legitimately mentions @font-face
    // to explain why there isn't one.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/@font-face\s*\{/);
  });
});

/** WCAG relative luminance / contrast ratio for two #rrggbb colours. */
function contrastRatio(a: string, b: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => {
    const h = hex.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Read a token's value from the light `:root` block. */
function lightToken(name: string): string {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  return root.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? '';
}

describe('022 — light-register control boundaries meet WCAG 1.4.11 (>=3:1)', () => {
  /**
   * EXTERNAL REVIEW P2 (round 2): `--color-border` (#d8dfe7) gives only
   * 1.24:1 on `--color-surface-elevated`, so control outlines were effectively
   * invisible once light became the default. Controls now use
   * `--color-border-strong`; this pins it so the boundary cannot silently
   * regress below the non-text threshold.
   */
  it('--color-border-strong clears 3:1 on every light surface it borders', () => {
    const strong = lightToken('--color-border-strong');
    expect(strong, 'light --color-border-strong not found').toMatch(/^#[0-9a-fA-F]{6}$/);
    for (const surface of ['--color-surface', '--color-surface-elevated', '--color-background']) {
      const bg = lightToken(surface);
      expect(bg, `${surface} not found`).toMatch(/^#[0-9a-fA-F]{6}$/);
      const ratio = contrastRatio(strong, bg);
      expect(
        ratio,
        `${strong} on ${surface} (${bg}) is ${ratio.toFixed(2)}:1, need >=3`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('EVERY interactive control uses the strong border — discovered, not listed', () => {
    // EXTERNAL REVIEW P2 (rounds 2-4). Round 2 fixed only the global form
    // rule; round 3 fixed eight named controls; round 4 still found two more
    // (`.catalogue-search__input`, which OVERRIDES the global input rule, and
    // `.btn--secondary`).
    //
    // The earlier version of this test hardcoded a list, so it could only
    // verify controls someone had already thought of — the same "passes
    // because it isn't looking" failure as the original token guard, in a
    // test written to prevent exactly that. It now SCANS for interactive
    // selectors instead, so a newly added control is caught by default.
    //
    // Display surfaces are allowlisted explicitly: WCAG 1.4.11 governs UI
    // COMPONENT boundaries, so cards, chips and panels keep the quiet
    // hairline. Adding to this list is a deliberate, reviewed act.
    const DISPLAY_SURFACES =
      /(^|[.\s])(card|panel|pane|chip|banner|strip|skeleton|overlay|divider|summary|table|__head|__grid|__display|screen-too-small|settings-section|dashboard-card|amount-due-card|top-bar__)/i;
    const INTERACTIVE = /(input|textarea|select|btn|button|key|item-btn|search|tab|toggle|option)/i;

    const weak: string[] = [];
    for (const match of css.matchAll(
      /\n\s*(\.[a-z0-9_.\-]+(?:,\s*\n\s*\.[a-z0-9_.\-]+)*)\s*\{([^}]*)\}/gi,
    )) {
      const selector = (match[1] ?? '').replace(/\s+/g, ' ').trim();
      const body = match[2] ?? '';
      if (!/border(-color)?:\s*(1px solid )?var\(--color-border\)/.test(body)) continue;
      if (!INTERACTIVE.test(selector)) continue;
      if (DISPLAY_SURFACES.test(selector)) continue;
      weak.push(selector);
    }
    expect(weak, `interactive controls still on the 1.24:1 hairline: ${weak.join(' | ')}`).toEqual(
      [],
    );
  });

  it('form controls use the STRONG border token, not the decorative hairline', () => {
    // The global control rule (input/select/textarea) is the boundary WCAG
    // 1.4.11 governs; decorative `--color-border` dividers are out of scope.
    // Anchor on the GLOBAL selector list (line-start + two-space indent), not
    // any scoped variant — `.pairing-screen__field input[type='text'],` also
    // contains this substring and would match first.
    const start = css.indexOf("\n  input[type='text'],");
    expect(start, 'global control rule not found').toBeGreaterThan(-1);
    const controlRule = css.slice(start, css.indexOf('}', start));
    expect(controlRule).toMatch(/border:\s*1px solid var\(--color-border-strong\)/);
    // And it must NOT fall back to the decorative hairline.
    expect(controlRule).not.toMatch(/border:\s*1px solid var\(--color-border\)/);
  });
});
