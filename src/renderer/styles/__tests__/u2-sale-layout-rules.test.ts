/**
 * 022 U2 / T060 — regression lock on the authored sale-layout track rules.
 *
 * WHAT THIS IS: a source-text assertion. It reads `tailwind.css` and checks the
 * three rules that decide the sale-layout tracks are still written as intended.
 * It is a tripwire against someone silently reverting the FR-15 correction or
 * dropping the specificity guard.
 *
 * WHAT THIS IS NOT — read before trusting it:
 *   - It does NOT verify the cascade. It is substring matching on source, so a
 *     later rule elsewhere in the file overriding `.sale-layout` tracks would
 *     pass here unnoticed.
 *   - It does NOT verify rendering. jsdom does no layout, and the built CSS is
 *     gitignored and produced AFTER `npm test` in CI, so neither is reachable
 *     from the unit suite.
 *   - It is therefore NOT FR-15 coverage. FR-15's evidence is the T0D1
 *     screenshot comparison against visual-references/03-sale-workspace.png.
 *
 * Being text-exact, it will also break on a harmless reformat of these rules.
 * That is the accepted cost of the tripwire: re-read the rule, confirm the
 * intent still holds, update the expected string.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf8');
const normalised = css.replace(/\s+/g, ' ');

describe('U2 / T060 — authored sale-layout track rules (FR-15 tripwire)', () => {
  it('declares the cart-dominant rule with the cart on the flexible track', () => {
    // Under the root dir="rtl" the grid flows on the inline axis, so track 1 is
    // the visual RIGHT: `380px 1fr` puts the catalogue rail right (the
    // reference's "الأصناف والمنتجات" panel) and the cart in the larger left
    // region — the FR-15 correction to v3.5's catalogue-major `1fr 380px`.
    expect(normalised).toContain(
      ".sale-layout[data-cart-dominant='true'] { grid-template-columns: 380px 1fr; }",
    );
  });

  it('leaves the base rule catalogue-major so the attribute is what flips it', () => {
    expect(normalised).toContain('.sale-layout { display: grid; grid-template-columns: 1fr 380px;');
  });

  it('keeps the narrow-terminal stacking rule matching the attribute selector', () => {
    // Specificity guard: `.sale-layout[data-cart-dominant='true']` is (0,2,0)
    // and a bare `.sale-layout` is (0,1,0), so the media query MUST list both
    // or a narrow terminal would keep two tracks.
    expect(normalised).toContain(
      ".sale-layout, .sale-layout[data-cart-dominant='true'] { grid-template-columns: 1fr; }",
    );
  });
});
