import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-244 (VNext W1-D) — guards for the entry screens' stylesheet, which
 * replaced the v4 sign-in CSS. happy-dom resolves no layout, so these are
 * source checks (tripwires), not cascade verification; the 1024/1280 light and
 * forced-colours captures are the visual proof.
 */

const css = readFileSync(resolve(__dirname, '../entry.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The body of the first rule whose selector list is exactly `selector`. */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (match === null) throw new Error(`rule ${selector} not found`);
  return match[1] ?? '';
}

/** The concatenated bodies of every `@media <query>` block. */
function mediaBlocks(source: string, query: RegExp): string {
  const out: string[] = [];
  const opener = new RegExp(`@media\\s*${query.source}\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(source.slice(start, i - 1));
  }
  return out.join('\n');
}

function pxVar(body: string, name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)px`).exec(body);
  if (match === null) throw new Error(`--${name} has no px value here`);
  return Number(match[1]);
}

const comfortable = ruleBody(css, '.v5-entry');
const compact = ruleBody(mediaBlocks(css, /\(max-width:\s*1279px\)/), '.v5-entry');
const forced = mediaBlocks(css, /\(forced-colors:\s*active\)/);
// The entry buttons are shared v5-btn buttons: their forced-colours edge lives in the system.
const buttonsForced = mediaBlocks(
  readFileSync(resolve(__dirname, '../../foundation/buttons.css'), 'utf-8'),
  /\(forced-colors:\s*active\)/,
);

describe('RT-244 entry.css — tokens and target floors', () => {
  it('pins no raw colour literal: every colour is a token or a system colour', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
  });

  it.each([
    ['comfortable (1280)', comfortable],
    ['compact (1024)', compact],
  ])('keeps every key, tile and commit at or above the 44px floor — %s', (_label, body) => {
    for (const name of ['entry-key', 'entry-tile', 'entry-commit']) {
      expect(pxVar(body, name), `--${name}`).toBeGreaterThanOrEqual(44);
    }
  });

  it.each([
    ['comfortable (1280)', comfortable],
    ['compact (1024)', compact],
  ])('the PIN column holds three 44px keys with their gaps and padding — %s', (_label, body) => {
    const column = pxVar(body, 'entry-auth-col');
    // 3 keys + 2 × 8px gaps + 2 × 20px padding (the larger profile) + 2 × 1px border.
    expect(column).toBeGreaterThanOrEqual(3 * 44 + 2 * 8 + 2 * 20 + 2);
  });

  it('keypad keys keep the 56/64px G-1 heights', () => {
    expect(pxVar(comfortable, 'entry-key')).toBe(64);
    expect(pxVar(compact, 'entry-key')).toBe(56);
  });
});

describe('RT-244 entry.css — Windows contrast themes', () => {
  it.each([
    "\\.v5-entry__who\\[aria-pressed='true'\\]",
    "\\.v5-entry__btn\\[aria-pressed='true'\\]",
  ])('the selected state %s keeps a system highlight that survives the backplate', (selector) => {
    const rule = new RegExp(`${selector}[^{]*\\{([^}]*)\\}`).exec(forced)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*Highlight/);
    expect(rule).toMatch(/color:\s*HighlightText/);
    expect(rule).toMatch(/forced-color-adjust:\s*none/);
  });

  // The light rule is `.v5-entry__btn.v5-btn[aria-pressed='true']` (0,3,0); a forced
  // rule at (0,2,0) would lose to it, leaving a white icon on the teal tint in a
  // contrast theme. The forced selectors must tie it, and win on source order.
  it('the pressed entry toggle keeps Highlight at the light rule specificity', () => {
    const rule =
      /\.v5-entry__btn\.v5-btn\[aria-pressed='true'\],\s*\.v5-entry__btn\.v5-btn\[aria-pressed='true'\]:hover:not\(:disabled\),\s*\.v5-entry__btn\.v5-btn\[aria-pressed='true'\]:active:not\(:disabled\)\s*\{([^}]*)\}/.exec(
        forced,
      )?.[1] ?? '';
    expect(rule).toMatch(/background:\s*Highlight/);
    expect(rule).toMatch(/color:\s*HighlightText/);
  });

  it('a filled PIN dot is drawn by its border, so it never un-forces', () => {
    const rule = /\.v5-entry__dot\[data-state='filled'\]\s*\{([^}]*)\}/.exec(forced)?.[1] ?? '';
    expect(rule).toMatch(/border-width:\s*7px/);
    expect(rule).not.toMatch(/forced-color-adjust/);
  });

  it('every control keeps a visible boundary', () => {
    expect(forced).toMatch(/\.v5-entry__key[\s\S]*?border-color:\s*CanvasText/);
    // The entry primary is a shared v5-btn--primary: its filled edge lives in foundation/buttons.css.
    expect(buttonsForced).toMatch(
      /\.v5-btn\.v5-btn--primary[^{]*\{[^}]*border:\s*3px solid ButtonText/,
    );
  });
});

describe('RT-244 PR2 entry.css — the Ready and pairing card', () => {
  it('holds one card of about 440px, padded 32/28px by density', () => {
    expect(ruleBody(css, '.v5-entry__card')).toMatch(/inline-size:\s*min\(440px,\s*100%\)/);
    expect(pxVar(comfortable, 'entry-card-pad')).toBe(32);
    expect(pxVar(compact, 'entry-card-pad')).toBe(28);
  });

  it('centres the card safely, so an oversized card scrolls from its top (RT-313)', () => {
    expect(ruleBody(css, '.v5-entry__center')).toMatch(/place-items:\s*safe center/);
    expect(ruleBody(css, '.v5-entry__center')).toMatch(/overflow-y:\s*auto/);
  });

  it('sets the pairing code in the mono token, LTR-aligned by the shared field rule', () => {
    expect(ruleBody(css, '.v5-entry__code-input')).toMatch(
      /font-family:\s*var\(--font-family-mono\)/,
    );
    expect(ruleBody(css, ".v5-entry__input[dir='ltr']")).toMatch(/text-align:\s*left/);
  });

  it('keeps the card, its icon and its fact visible under forced colours', () => {
    expect(forced).toMatch(/\.v5-entry__card\s*\{[^}]*border-color:\s*CanvasText/);
    expect(forced).toMatch(/\.v5-entry__facts\s*\{[^}]*border:\s*1px solid CanvasText/);
  });
});
