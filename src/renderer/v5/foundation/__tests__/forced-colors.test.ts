import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-241 (VNext W1-A, VN-S2) — `forced-colors: active` rules for the V5 frame
 * and Sale (freeze 15 §4 "High contrast", DESIGN.md: Windows contrast themes
 * must work). happy-dom cannot evaluate the media query, so these assert the
 * rules exist inside a forced-colors block; the 1024/1280 forced-colors
 * captures are the visual proof.
 *
 * What each rule protects: a contrast theme drops background tints and
 * shadows, so a state carried only by a tint (the current nav entry, the
 * highlighted result) or a filled primary button would disappear.
 */

const read = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The concatenated bodies of every `@media (forced-colors: active)` block. */
function forcedColorsCss(css: string): string {
  const out: string[] = [];
  const opener = /@media\s*\(forced-colors:\s*active\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(css)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(start, i - 1));
  }
  return out.join('\n');
}

/** The declarations of `selector` inside the forced-colors CSS (selector lists allowed). */
function ruleFor(css: string, selector: string): string {
  const rules = css.split('}');
  for (const rule of rules) {
    const [selectors, body] = rule.split('{');
    if (body === undefined || selectors === undefined) continue;
    const list = selectors.split(',').map((s) => s.trim());
    if (list.includes(selector)) return body;
  }
  throw new Error(`no forced-colors rule for ${selector}`);
}

const frame = forcedColorsCss(read('../../frame/frame.css'));
const sale = forcedColorsCss(read('../../sale/live-sale.css'));
const checkout = forcedColorsCss(read('../../checkout/checkout.css'));
// The shared button system owns every button's forced-colours edge (foundation/buttons.css).
const buttons = forcedColorsCss(read('../buttons.css'));

describe('forced colors — V5 frame', () => {
  it('the current nav entry is a system selection, not a tint', () => {
    const body = ruleFor(frame, '.v5-frame__link--active');
    expect(body).toMatch(/background:\s*Highlight/);
    expect(body).toMatch(/color:\s*HighlightText/);
    // Without it Chromium paints a Canvas backplate behind the text, hiding
    // HighlightText on Highlight (seen as a black box in the R-dev capture).
    expect(body).toMatch(/forced-color-adjust:\s*none/);
  });

  it('the brand tile keeps an edge when its fill is dropped', () => {
    expect(ruleFor(frame, '.v5-frame__brand-mark')).toMatch(/border:\s*1px solid CanvasText/);
  });

  it('the sign-out confirm (a filled danger button) gets the 3px ButtonText border', () => {
    // Now a shared v5-btn--danger: the system rule carries the edge for every filled danger button.
    expect(ruleFor(buttons, '.v5-btn.v5-btn--danger')).toMatch(/border:\s*3px solid ButtonText/);
  });
});

describe('forced colors — Sale', () => {
  // The dialog primary/danger and the Sale CTA are shared v5-btn buttons (foundation/buttons.css).
  it.each(['.v5-btn.v5-btn--primary', '.v5-btn.v5-btn--danger'])(
    '%s (filled action) gets the 3px ButtonText border',
    (selector) => {
      expect(ruleFor(buttons, selector)).toMatch(/border:\s*3px solid ButtonText/);
    },
  );

  it('the highlighted result carries a system Highlight edge, not a tint', () => {
    // A thick Highlight outline, not a Highlight fill: forced-color-adjust is
    // inherited, so a filled row would also un-force its «اختيار» button.
    const body = ruleFor(sale, ".v5-sale-product-row[aria-selected='true']");
    expect(body).toMatch(/outline:\s*3px solid Highlight/);
    expect(body).not.toMatch(/forced-color-adjust/);
  });

  it('list focus keeps its own outline; nothing overrides the selected row Highlight edge', () => {
    // The list's focus ring is an outline (survives forced colors); the inset
    // box-shadow on the selected row is dropped, so the row keeps only its edge.
    expect(() =>
      ruleFor(
        sale,
        ".v5-sale-product-list:focus-visible .v5-sale-product-row[aria-selected='true']",
      ),
    ).toThrow();
  });

  it('a disabled button reads as disabled without its opacity fade', () => {
    // The selector list holds a comma inside :is(), so match it directly rather than via ruleFor.
    const body =
      /\.v5-btn:is\(:disabled, \[aria-disabled='true'\]\)\s*\{([^}]*)\}/.exec(buttons)?.[1] ?? '';
    expect(body).toMatch(/color:\s*GrayText/);
    expect(body).toMatch(/border-color:\s*GrayText/);
  });
});

describe('forced colors — Checkout (RT-243 W1-C)', () => {
  it('the selected tender tile is a system selection, not a tint', () => {
    const body = ruleFor(checkout, ".v5-tender-tile[aria-checked='true']");
    expect(body).toMatch(/background:\s*Highlight/);
    expect(body).toMatch(/color:\s*HighlightText/);
    expect(body).toMatch(/forced-color-adjust:\s*none/);
  });

  it('a tile disabled by policy (the pilot voucher) reads as disabled', () => {
    const body = ruleFor(checkout, '.v5-tender-tile:disabled');
    expect(body).toMatch(/color:\s*GrayText/);
    expect(body).toMatch(/border-color:\s*GrayText/);
  });

  it.each(['.v5-order-summary', '.v5-checkout__tender', '.v5-ledger'])(
    '%s keeps its panel edge when tints are dropped',
    (selector) => {
      expect(ruleFor(checkout, selector)).toMatch(/border-color:\s*CanvasText/);
    },
  );
});

/**
 * RT-313 — the height notice and the scrolling dialog in a contrast theme.
 * The notice's variant is carried by its text alone, so nothing in it may opt
 * out of forced colors; the dialog's pinned action row must stay an opaque
 * fill (forced to Canvas), or scrolled content would show through it.
 */
const globalCss = read('../../../styles/tailwind.css');
const dialogCss = read('../dialog.css');

/** Every rule body for selectors starting with `prefix`, outside or inside media blocks. */
function rulesStartingWith(css: string, prefix: string): string[] {
  return css
    .split('}')
    .map((rule) => rule.split('{'))
    .filter(([selectors]) =>
      (selectors ?? '').split(',').some((sel) => sel.trim().startsWith(prefix)),
    )
    .map(([, body]) => body ?? '');
}

describe('forced colors — viewport notice and dialog (RT-313)', () => {
  it('no ScreenTooSmall rule opts out of forced colors', () => {
    const rules = rulesStartingWith(globalCss, '.screen-too-small');
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) expect(body).not.toMatch(/forced-color-adjust/);
  });

  it('the notice card has a real border, which survives when its shadow is dropped', () => {
    const card = rulesStartingWith(globalCss, '.screen-too-small__card').join('\n');
    expect(card).toMatch(/border:\s*1px solid/);
  });

  it('the pinned action row is an opaque fill and never opts out of forced colors', () => {
    const row = ruleFor(dialogCss, '.v5-dialog > div:last-child');
    expect(row).toMatch(/background:\s*var\(--color-surface\)/);
    expect(dialogCss).not.toMatch(/forced-color-adjust/);
  });

  it('the dialog panel keeps its 2px CanvasText edge', () => {
    expect(ruleFor(forcedColorsCss(dialogCss), '.v5-dialog')).toMatch(
      /border:\s*2px solid CanvasText/,
    );
  });
});
