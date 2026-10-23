import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-681 — the 022-era Checkout classes are retired and must not come back.
 *
 * Checkout (`/app/checkout`) is built from the V5 vocabulary (`v5/checkout/checkout.css`).
 * The 022 names (`checkout-actions*`, `checkout-commit`, `payment-surface__*`,
 * `tender-slots`, `tender-row*`, `operator-badge__*`) lived in the global
 * `tailwind.css`; this guard fails CI when one is named in production `.tsx` or
 * defined in any renderer stylesheet again (as RT-652 did for `.btn`).
 *
 * The `data-testid` values `payment-surface*` and `operator-badge` are test hooks,
 * not classes, and are deliberately not matched: only the retired class shapes are.
 */

const RENDERER = resolve(__dirname, '../..');
const REPO = resolve(RENDERER, '../..');

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const isTest = (path: string): boolean => /[\\/]__tests__[\\/]|\.test\.tsx?$/.test(path);
const PRODUCTION_TSX = walk(RENDERER, (p) => extname(p) === '.tsx' && !isTest(p));
const STYLESHEETS = walk(RENDERER, (p) => extname(p) === '.css');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every string and template-literal piece in the code, split into class-like words. */
function stringWords(source: string): string[] {
  const words: string[] = [];
  for (const match of stripComments(source).matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
    words.push(...(match[2] ?? '').split(/[\s${}]+/));
  }
  return words;
}

/**
 * The retired class shapes. `operator-badge` and `payment-surface` alone are
 * test ids, so only their `__element` forms are class names here; the bare
 * `.operator-badge` is caught as a selector below.
 */
const RETIRED_BODY = String.raw`(?:checkout-(?:actions|commit|back|heading)(?:__[\w-]+|--[\w-]+)?|payment-surface__[\w-]+|tender-(?:slots|row)(?:__[\w-]+|--[\w-]+)?|operator-badge__[\w-]+)`;

// A word is a class token (optionally written as a selector, `.name`).
const RETIRED_WORD = new RegExp(String.raw`^\.?${RETIRED_BODY}$`);
// A stylesheet selector. `.v5-checkout-actions` has `.v5-` before it, so it never matches.
const RETIRED_RULE = new RegExp(String.raw`\.${RETIRED_BODY}(?![\w-])`);
// The bare `.operator-badge` class (its test id is never a selector).
const RETIRED_BADGE_RULE = /\.operator-badge(?![\w-])/;
// The bare class names that are legitimate words elsewhere (test ids), checked in className only.
const RETIRED_BARE_CLASS_WORD =
  /^(?:operator-badge|checkout-actions|checkout-commit|tender-slots)$/;

describe('022 Checkout class retirement guard (RT-681)', () => {
  it('scans a real tree, not an empty one', () => {
    expect(PRODUCTION_TSX.length).toBeGreaterThan(100);
    expect(STYLESHEETS.length).toBeGreaterThan(5);
  });

  it('no production .tsx names a retired Checkout class', () => {
    const offenders = PRODUCTION_TSX.flatMap((file) =>
      stringWords(readFileSync(file, 'utf-8'))
        .filter((word) => RETIRED_WORD.test(word))
        .map((word) => `${relative(REPO, file)} → ${word}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no production .tsx puts a bare retired class in a className', () => {
    const offenders = PRODUCTION_TSX.flatMap((file) =>
      [
        ...stripComments(readFileSync(file, 'utf-8')).matchAll(
          /className=(?:"([^"]*)"|\{`([^`]*)`\})/g,
        ),
      ]
        .flatMap((match) => (match[1] ?? match[2] ?? '').split(/\s+/))
        .filter((word) => RETIRED_BARE_CLASS_WORD.test(word))
        .map((word) => `${relative(REPO, file)} → ${word}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no renderer stylesheet defines a retired Checkout selector', () => {
    const offenders = STYLESHEETS.filter((file) => {
      const css = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
      return RETIRED_RULE.test(css) || RETIRED_BADGE_RULE.test(css);
    });
    expect(offenders.map((file) => relative(REPO, file))).toEqual([]);
  });

  it('the V5 checkout stylesheet carries the moved rules under V5 names', () => {
    const css = readFileSync(join(RENDERER, 'v5/checkout/checkout.css'), 'utf-8');
    for (const name of [
      '.v5-checkout-actions',
      '.v5-checkout-actions__slot--end',
      '.v5-entry-slots',
      '.v5-entry-row',
      '.v5-operator-badge',
      '.v5-operator-badge__role',
    ]) {
      expect(css).toContain(name);
    }
  });

  it('the scans see a retired class and let the V5 names and test ids through', () => {
    const words = stringWords('const c = `checkout-actions__slot ${x}`;');
    expect(words.some((w) => RETIRED_WORD.test(w))).toBe(true);
    expect(RETIRED_WORD.test('.payment-surface__entry')).toBe(true);
    expect(RETIRED_WORD.test('v5-checkout-actions__slot')).toBe(false);
    expect(RETIRED_WORD.test('payment-surface-confirm')).toBe(false);
    expect(RETIRED_WORD.test('operator-badge')).toBe(false);
    expect(RETIRED_RULE.test('.v5-checkout-actions__row{}')).toBe(false);
    expect(RETIRED_RULE.test('.tender-row__label{}')).toBe(true);
    expect(RETIRED_BADGE_RULE.test('.v5-operator-badge{}')).toBe(false);
  });
});
