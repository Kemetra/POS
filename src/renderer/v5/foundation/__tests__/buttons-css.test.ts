import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shared V5 button system (foundation/buttons.css). happy-dom resolves no
 * cascade, so these are source tripwires: the file exists and is loaded, the
 * base defines every state the owner approved, and the 150ms settle-in carries
 * its exclusions and its reduced-motion path. The 1024/1280 captures, in light
 * and forced colours, are the visual proof.
 */

const FOUNDATION = resolve(__dirname, '..');
const RENDERER = resolve(FOUNDATION, '../..');

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (path: string): string => strip(readFileSync(path, 'utf-8'));

const buttonsPath = resolve(FOUNDATION, 'buttons.css');
const buttons = existsSync(buttonsPath) ? read(buttonsPath) : '';

/** The text of every `@media <query>` block, brace-balanced. */
function mediaBlocks(css: string, query: string): string {
  const out: string[] = [];
  const opener = new RegExp(`@media\\s*\\(${query}\\)\\s*\\{`, 'g');
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

describe('buttons.css — present and loaded', () => {
  it('exists and defines the base and every approved modifier', () => {
    expect(existsSync(buttonsPath)).toBe(true);
    for (const selector of [
      '.v5-btn',
      '.v5-btn--primary',
      '.v5-btn--quiet',
      '.v5-btn--danger-quiet',
      '.v5-btn--danger',
      '.v5-btn--commit',
    ]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(buttons, selector).toMatch(new RegExp(`${escaped}\\s*\\{`));
    }
  });

  it('is imported once, globally, from the renderer entry', () => {
    const main = readFileSync(resolve(RENDERER, 'main.tsx'), 'utf-8');
    const imports = main.match(/import\s+'\.\/v5\/foundation\/buttons\.css';/g) ?? [];
    expect(imports).toHaveLength(1);
  });
});

describe('buttons.css — every state the owner approved', () => {
  it('defines press, focus, unavailable and busy on .v5-btn', () => {
    expect(buttons).toMatch(/\.v5-btn:active:not\(:disabled,\s*\[aria-disabled='true'\]\)/);
    expect(buttons).toMatch(
      /\.v5-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus-ring\)/,
    );
    expect(buttons).toMatch(/\.v5-btn:focus-visible\s*\{[^}]*outline-offset:\s*2px/);
    expect(buttons).toMatch(/\.v5-btn:is\(:disabled,\s*\[aria-disabled='true'\]\)/);
    expect(buttons).toMatch(/\.v5-btn\[aria-busy='true'\]\s*\{[^}]*cursor:\s*progress/);
  });

  it('presses one pixel down on the Contact role', () => {
    const press = /\.v5-btn:active:not\([^)]*\)\s*\{([^}]*)\}/.exec(buttons)?.[1] ?? '';
    expect(press).toMatch(/translateY\(1px\)/);
    expect(buttons).toMatch(/transform var\(--motion-press,\s*var\(--duration-1\)\)/);
  });

  it('recesses an unavailable button instead of fading it, and dashes an unavailable commit', () => {
    const unavailable =
      /\.v5-btn:is\(:disabled,\s*\[aria-disabled='true'\]\)\s*\{([^}]*)\}/.exec(buttons)?.[1] ?? '';
    expect(unavailable).toMatch(/background:\s*var\(--color-surface-sunken\)/);
    expect(unavailable).toMatch(/border-color:\s*var\(--color-border\)/);
    // Opacity belongs to the settle keyframes only; no button state fades.
    expect(buttons.replace(/@keyframes[\s\S]*?\n\}/, '')).not.toMatch(/opacity\s*:/);
    expect(buttons).toMatch(
      /\.v5-btn--commit:is\(:disabled,\s*\[aria-disabled='true'\]\)\s*\{[^}]*2px dashed var\(--color-border-strong\)/,
    );
  });

  it('keeps the 44px floor and the 56px commit, with the shipped control radius', () => {
    const base = /\.v5-btn\s*\{([^}]*)\}/.exec(buttons)?.[1] ?? '';
    expect(base).toMatch(/min-block-size:\s*44px/);
    expect(base).toMatch(/min-inline-size:\s*44px/);
    expect(base).toMatch(/border-radius:\s*var\(--radius-control\)/);
    const commit = /\.v5-btn--commit\s*\{([^}]*)\}/.exec(buttons)?.[1] ?? '';
    expect(commit).toMatch(/min-block-size:\s*56px/);
    expect(commit).toMatch(/inline-size:\s*100%/);
  });

  it('gives keypad keys and tender tiles the same press and the teal focus ring', () => {
    expect(buttons).toMatch(/\.v5-cash-keypad__key:active:not\(:disabled\)/);
    expect(buttons).toMatch(/\.v5-tender-tile:active:not\(:disabled/);
    expect(buttons).toMatch(
      /\.v5-cash-keypad__key:focus-visible,\s*\.v5-tender-tile:focus-visible\s*\{[^}]*2px solid var\(--color-focus-ring\)/,
    );
  });
});

describe('buttons.css — tokens, motion roles and reduced motion', () => {
  it('pins no raw colour literal', () => {
    expect(buttons).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(buttons).not.toMatch(/rgba?\(|hsla?\(/);
  });

  it('uses logical properties only', () => {
    expect(buttons).not.toMatch(
      /(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\b|(?:^|[\s;{])(?:left|right)\s*:/m,
    );
  });

  it('takes durations from the three motion roles, each with a token fallback', () => {
    const durations = [...buttons.matchAll(/\b(\d+)ms\b/g)].map((m) => m[0]);
    expect(durations).toEqual([]);
    for (const use of buttons.matchAll(/var\((--motion-[\w-]+)(,[^)]*\))?/g)) {
      expect(use[2], `${String(use[1])} needs a fallback`).toBeDefined();
    }
  });

  it('has a reduced-motion block that removes the press drop and the colour fade', () => {
    const reduced = mediaBlocks(buttons, 'prefers-reduced-motion:\\s*reduce');
    expect(reduced).toMatch(/\.v5-btn\s*\{[^}]*transition:\s*none/);
    // The override must repeat the press selectors exactly: a media query adds
    // no specificity, so a bare `.v5-btn:active` (0,2,0) loses to the press rule
    // `.v5-btn:active:not(…)` (0,3,0) and the drop survives reduced motion.
    for (const press of [
      ".v5-btn:active:not(:disabled, [aria-disabled='true'])",
      '.v5-cash-keypad__key:active:not(:disabled)',
      ".v5-tender-tile:active:not(:disabled, [aria-checked='true'])",
    ]) {
      expect(reduced, press).toContain(press);
    }
    expect(reduced).toMatch(
      /\.v5-tender-tile:active:not\(:disabled, \[aria-checked='true'\]\)\s*\{[^}]*transform:\s*none;[^}]*transition:\s*none/,
    );
  });

  it('never settles a notice that carries a money amount in the ledger or the entry', () => {
    const messages = read(resolve(FOUNDATION, 'messages.css'));
    expect(messages).toMatch(
      /\.v5-ledger \.v5-notice,\s*\.v5-checkout__entry \.v5-notice[^{]*\{[^}]*animation:\s*none/,
    );
  });

  it('keeps every state distinguishable in a contrast theme', () => {
    const forced = mediaBlocks(buttons, 'forced-colors:\\s*active');
    expect(forced).toMatch(/\.v5-btn\s*\{[^}]*border:\s*1px solid ButtonText/);
    expect(forced).toMatch(/\.v5-btn\.v5-btn--primary[^{]*\{[^}]*border:\s*3px solid ButtonText/);
    expect(forced).toMatch(
      /\.v5-btn:is\(:disabled,\s*\[aria-disabled='true'\]\)\s*\{[^}]*GrayText/,
    );
    expect(forced).toMatch(/\.v5-btn\.v5-btn--commit:is\([^)]*\)\s*\{[^}]*2px dashed GrayText/);
  });
});

describe('the 150ms settle-in (Signal)', () => {
  const messages = read(resolve(FOUNDATION, 'messages.css'));
  const scan = read(resolve(RENDERER, 'scan/scan-notice.css'));
  const checkout = read(resolve(RENDERER, 'v5/checkout/checkout.css'));
  const completion = read(resolve(RENDERER, 'v5/checkout/completion.css'));
  const recovery = read(resolve(RENDERER, 'v5/recovery/recovery.css'));

  it('defines the keyframes once, a drop of 4px and a fade', () => {
    const all = [buttons, messages, scan, checkout, completion, recovery];
    expect(all.filter((css) => /@keyframes v5-settle\b/.test(css))).toHaveLength(1);
    const body = /@keyframes v5-settle\s*\{([\s\S]*?)\n\}/.exec(buttons)?.[1] ?? '';
    expect(body).toMatch(/opacity:\s*0/);
    expect(body).toMatch(/translateY\(-4px\)/);
  });

  it.each([
    ['messages.css', messages],
    ['scan-notice.css', scan],
    ['checkout.css', checkout],
    ['completion.css', completion],
  ])('%s applies it on the Signal alias and switches it off under reduced motion', (_name, css) => {
    expect(css).toMatch(
      /animation:\s*v5-settle\s+var\(--motion-notice-in,\s*var\(--duration-2\)\)\s+var\(--motion-ease,\s*var\(--ease-out\)\)/,
    );
    expect(mediaBlocks(css, 'prefers-reduced-motion:\\s*reduce')).toMatch(
      /animation:\s*none;\s*transform:\s*none/,
    );
  });

  it('never settles a danger-toned message or anything inside a recovery surface', () => {
    expect(messages).toMatch(/\.v5-notice:not\(\[data-tone='danger'\]\)/);
    expect(messages).toMatch(/\.v5-banner:not\(\[data-tone='danger'\]\)/);
    expect(messages).toMatch(
      /\.v5-recovery \.v5-notice,\s*\.v5-recovery \.v5-banner\s*\{[^}]*animation:\s*none/,
    );
    expect(recovery).not.toMatch(/v5-settle/);
  });

  it('settles only the outcome line of the completion, never its money', () => {
    expect(completion).toMatch(/\.v5-proof-line\[data-tone='success'\] > \.v5-tone-icon/);
    expect(completion).toMatch(/\.v5-proof-line\[data-tone='success'\] > \.v5-proof-line__label/);
    expect(completion).not.toMatch(/v5-proof-line__value[^{]*\{[^}]*v5-settle/);
    expect(completion).not.toMatch(/\.v5-completion__panel[^{]*\{[^}]*v5-settle/);
  });
});
