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

describe('forced colors — V5 frame', () => {
  it('the current nav entry is a system selection, not a tint', () => {
    const body = ruleFor(frame, '.v5-frame__link--active');
    expect(body).toMatch(/background:\s*Highlight/);
    expect(body).toMatch(/color:\s*HighlightText/);
  });

  it('the brand tile keeps an edge when its fill is dropped', () => {
    expect(ruleFor(frame, '.v5-frame__brand-mark')).toMatch(/border:\s*1px solid CanvasText/);
  });

  it('the sign-out confirm (a filled danger button) gets the 3px ButtonText border', () => {
    expect(ruleFor(frame, '.v5-frame__sign-out .v5-frame__sign-out-confirm')).toMatch(
      /border:\s*3px solid ButtonText/,
    );
  });
});

describe('forced colors — Sale', () => {
  it.each(['.v5-live-btn--primary', '.v5-live-btn--danger', '.v5-live-sale .v5-sale-checkout'])(
    '%s (filled primary) gets the 3px ButtonText border',
    (selector) => {
      expect(ruleFor(sale, selector)).toMatch(/border:\s*3px solid ButtonText/);
    },
  );

  it('the highlighted result is a system selection, not a tint', () => {
    const body = ruleFor(sale, ".v5-sale-product-row[aria-selected='true']");
    expect(body).toMatch(/background:\s*Highlight/);
    expect(body).toMatch(/color:\s*HighlightText/);
  });

  it('the focused list ring survives (shadows are dropped): an outline instead', () => {
    expect(
      ruleFor(
        sale,
        ".v5-sale-product-list:focus-visible .v5-sale-product-row[aria-selected='true']",
      ),
    ).toMatch(/outline:\s*2px solid CanvasText/);
  });

  it('a disabled button reads as disabled without its opacity fade', () => {
    const body = ruleFor(sale, '.v5-live-btn:disabled');
    expect(body).toMatch(/color:\s*GrayText/);
    expect(body).toMatch(/border-color:\s*GrayText/);
  });
});
