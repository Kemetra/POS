/**
 * 022 U2 / T060 — regression lock on the authored sale-layout track rules.
 *
 * WHAT THIS IS: a source-text assertion. It reads `tailwind.css` and checks the
 * rules that decide the sale-layout tracks are still written as intended. It is
 * a tripwire against someone silently reverting the FR-15 correction, dropping
 * the specificity guard, or re-introducing the lone-cart collapse.
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
  it('declares the two-region rule with the cart on the flexible track', () => {
    // Under the root dir="rtl" the grid flows on the inline axis, so track 1 is
    // the visual RIGHT: `380px 1fr` puts the catalogue rail right (the
    // reference's "الأصناف والمنتجات" panel) and the cart in the larger left
    // region — the FR-15 correction to v3.5's catalogue-major `1fr 380px`.
    expect(normalised).toContain(
      ".sale-layout[data-catalogue='true'] { grid-template-columns: 380px 1fr; }",
    );
  });

  it('keeps the base rule SINGLE-track so a lone cart fills the workspace', () => {
    // The rule that prevents the lone-cart collapse. `cart` and `productSearch`
    // are independent fail-closed flags, so the cart can be the layout's only
    // child; grid auto-places a lone child into track 1, which the FR-15 flip
    // made the fixed 380px rail. If this base ever regains a second track, a
    // solitary cart shrinks to a rail beside an empty column above 1023px.
    expect(normalised).toContain('.sale-layout { display: grid; grid-template-columns: 1fr;');
  });

  it('gates the two-region template on the catalogue, not on cart-dominance', () => {
    // `data-cart-dominant` is the FR-15 INTENT marker and is unconditional (a
    // lone cart is trivially dominant). It must not drive the track count, or
    // the two-track template applies when there is no catalogue to fill it.
    expect(normalised).not.toContain(
      ".sale-layout[data-cart-dominant='true'] { grid-template-columns:",
    );
  });

  it('keeps the narrow-terminal stacking rule matching the attribute selector', () => {
    // Specificity guard: `.sale-layout[data-catalogue='true']` is (0,2,0) and a
    // bare `.sale-layout` is (0,1,0), so the media query MUST list both or a
    // narrow terminal would keep two tracks. The two-track template is keyed on
    // ONE attribute precisely so this guard can match its specificity.
    expect(normalised).toContain(
      ".sale-layout, .sale-layout[data-catalogue='true'] { grid-template-columns: 1fr; }",
    );
  });
});
