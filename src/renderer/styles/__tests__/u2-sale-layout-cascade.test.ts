/**
 * 022 U2 / T060 — sale-layout track cascade, verified against the REAL CSS.
 *
 * The component test can only assert that the `data-cart-dominant` hook is
 * present; it cannot show the cart actually gets the major track, because the
 * attribute is hardcoded and jsdom does no layout. This test closes part of
 * that gap by parsing `tailwind.css` itself and checking the rules that decide
 * the tracks — cascade and specificity included.
 *
 * It is NOT a substitute for the T0D1 screenshot: it proves the rules resolve
 * as authored, not that the rendered result reads as cart-dominant.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf8');
const normalised = css.replace(/\s+/g, ' ');

describe('U2 / T060 — sale-layout grid tracks (FR-15)', () => {
  it('gives the cart the flexible major track when cart-dominant', () => {
    // Under the root dir="rtl" the grid flows on the inline axis: track 1 is
    // the visual RIGHT. So `380px 1fr` = catalogue rail right (the reference's
    // "الأصناف والمنتجات" panel), cart in the larger left region — the FR-15
    // correction to the v3.5 `1fr 380px`, which made the catalogue major.
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
