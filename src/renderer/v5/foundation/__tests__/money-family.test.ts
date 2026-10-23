import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-814 — money typography (RT-262 decision B, UX-03).
 *
 * Prices, totals and quantities use the UI sans with tabular lining numerals
 * through `--font-family-money`; the mono family stays for IDs, SKUs, codes,
 * PIN/reference fields, key hints and the receipt-slip preview. The two lists
 * below are the discovery proof: every renderer rule that still names the mono
 * token must be in MONO_ALLOWED, and every money rule must use the money token.
 */
const RENDERER_ROOT = resolve(__dirname, '../../..');

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

interface Rule {
  readonly file: string;
  readonly selectors: readonly string[];
  readonly decls: ReadonlyMap<string, string>;
}

function rulesOf(file: string, css: string): Rule[] {
  const rules: Rule[] = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const part of (m[2] ?? '').split(';')) {
      const [name, ...value] = part.split(':');
      if (name !== undefined && value.length > 0) decls.set(name.trim(), value.join(':').trim());
    }
    const selectors = (m[1] ?? '')
      .slice((m[1] ?? '').lastIndexOf(';') + 1)
      .split(',')
      .map((sel) => sel.replace(/\s+/g, ' ').trim())
      .filter((sel) => sel.length > 0 && !sel.startsWith('@'));
    rules.push({ file, selectors, decls });
  }
  return rules;
}

const rules: readonly Rule[] = cssFiles(RENDERER_ROOT).flatMap((path) =>
  rulesOf(path.slice(RENDERER_ROOT.length + 1).replace(/\\/g, '/'), readFileSync(path, 'utf-8')),
);

function declsFor(file: string, selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    if (rule.file !== file || !rule.selectors.includes(selector)) continue;
    for (const [k, v] of rule.decls) merged.set(k, v);
  }
  return merged;
}

const MONEY_SELECTORS: ReadonlyArray<[string, string]> = [
  ['v5/sale/sale-screen.css', '.v5-sale-product-price'],
  ['v5/sale/sale-screen.css', '.v5-sale-line-unit'],
  ['v5/sale/sale-screen.css', '.v5-sale-line-total'],
  ['v5/sale/sale-screen.css', '.v5-sale-quantity'],
  ['v5/sale/sale-screen.css', '.v5-sale-total-row > span:last-child'],
  ['v5/sale/sale-screen.css', '.v5-sale-grand-total strong'],
  ['v5/sale/sale-direction-b.css', '.v5-sale-money-counts dd'],
  ['v5/sale/live-sale.css', '.v5-live-dialog-price'],
  ['v5/checkout/checkout.css', '.v5-order-summary__amount'],
  ['v5/checkout/checkout.css', '.v5-cash__input'],
  ['v5/checkout/checkout.css', '.v5-quick-amount'],
  ['v5/checkout/checkout.css', '.v5-cash-keypad__key'],
  ['v5/checkout/checkout.css', '.v5-card__amount-value'],
  ['v5/checkout/checkout.css', '.v5-ledger__due-value'],
  ['v5/checkout/checkout.css', '.v5-ledger-row__amount'],
  ['v5/checkout/completion.css', '.v5-proof-line__value'],
  ['v5/shift/shift.css', '.v5-shift-money'],
  ['v5/shift/shift.css', '.v5-shift-amount'],
  ['v5/shift/shift.css', '.v5-shift-counts dd'],
  ['v5/manager/manager.css', '.v5-manager-num'],
  ['v5/void/void.css', '.v5-void-money'],
  ['v5/recovery/recovery.css', '.v5-recovery-money'],
  ['styles/tailwind.css', '.amount-due-card__value'],
];

/**
 * Every selector that may still use the mono family: IDs, SKUs, codes, PIN and
 * reference fields, kbd chips, the receipt-slip preview. RT-833 split the old
 * mixed `.v5-void-num` / `.v5-recovery-num`: amounts and counts are money
 * classes above, the sale number is `.v5-void-id` here.
 */
const MONO_ALLOWED: ReadonlyArray<[string, string]> = [
  ['styles/tailwind.css', '.voucher-field input'],
  ['styles/tailwind.css', '.voucher-applied'],
  ['v5/cashiers/cashiers.css', '.v5-cashiers-input--pin'],
  ['v5/checkout/checkout.css', '.v5-checkout-back kbd'],
  ['v5/checkout/checkout.css', '.v5-card__input'],
  ['v5/entry/entry.css', '.v5-entry__key'],
  ['v5/entry/entry.css', '.v5-entry__code-input'],
  ['v5/manager/manager.css', '.v5-manager-facts dd.v5-manager-id'],
  ['v5/manager/manager.css', '.v5-manager-id'],
  ['v5/manager/manager.css', '.v5-manager-input--code'],
  ['v5/manager/manager.css', '.v5-manager-num.v5-returns-code'],
  ['v5/manager/sales/receipt-preview.css', '.v5-receipt-head p'],
  ['v5/manager/sales/receipt-preview.css', '.v5-receipt-slip'],
  ['v5/manager/sales/sales.css', '.v5-sales-input--code'],
  ['v5/manager/sales/sales.css', '.v5-sales-ref'],
  ['v5/manager/stuck-shifts/stuck-shifts.css', '.v5-stuck-terminal'],
  ['v5/recovery/recovery.css', '.v5-recovery-input--code'],
  ['v5/recovery/recovery.css', '.v5-recovery-input--pin'],
  ['v5/sale/live-sale.css', '.v5-live-scan-field input'],
  ['v5/sale/sale-screen.css', '.v5-sale-brand strong'],
  ['v5/sale/sale-screen.css', '.v5-sale-key-hint'],
  ['v5/sale/sale-screen.css', '.v5-sale-line-index'],
  ['v5/sale/sale-screen.css', '.v5-sale-product-meta bdi'],
  ['v5/sale/sale-screen.css', '.v5-sale-line-meta bdi'],
  ['v5/shift/shift.css', '.v5-shift-pin'],
  ['v5/void/void.css', '.v5-void-input--code'],
  ['v5/void/void.css', '.v5-void-input--pin'],
  ['v5/void/void.css', '.v5-void-id'],
];

describe('RT-814 money family', () => {
  it('--font-family-money is the UI sans; mono is still the monospace stack', () => {
    const root = declsFor('styles/tailwind.css', ':root');
    expect(root.get('--font-family-money')).toBe('var(--font-family-sans)');
    expect(root.get('--font-family-mono')).toMatch(/^ui-monospace/);
  });

  it.each(MONEY_SELECTORS)(
    '%s %s uses the money family with tabular lining numerals',
    (file, sel) => {
      const decls = declsFor(file, sel);
      expect(decls.get('font-family'), `${sel} family`).toBe('var(--font-family-money)');
      expect(decls.get('font-variant-numeric'), `${sel} numerals`).toBe('tabular-nums lining-nums');
    },
  );

  it.each(MONO_ALLOWED)(
    '%s %s keeps the mono family (ID, code, reference or receipt slip)',
    (file, sel) => {
      expect(declsFor(file, sel).get('font-family'), sel).toBe('var(--font-family-mono)');
    },
  );

  it('no other renderer rule uses the mono family (discovery proof)', () => {
    const allowed = new Set(MONO_ALLOWED.map(([file, sel]) => `${file} ${sel}`));
    const stray = rules.flatMap((rule) =>
      rule.decls.get('font-family') === 'var(--font-family-mono)'
        ? rule.selectors.map((sel) => `${rule.file} ${sel}`).filter((id) => !allowed.has(id))
        : [],
    );
    expect(stray).toEqual([]);
  });
});

/** RT-833 — a class that styles both an ID and an amount must not come back. */
describe('RT-833 void and recovery num split', () => {
  const sources = ['v5/void', 'v5/recovery'].flatMap((dir) =>
    readdirSync(join(RENDERER_ROOT, dir))
      .filter((name) => /\.(css|tsx)$/.test(name))
      .map((name) => [`${dir}/${name}`, readFileSync(join(RENDERER_ROOT, dir, name), 'utf-8')]),
  );

  it.each(['v5-void-num', 'v5-recovery-num'])('the mixed class %s is retired', (cls) => {
    const users = sources.filter(([, text]) => (text ?? '').includes(cls)).map(([f]) => f);
    expect(users).toEqual([]);
  });

  it('the sale number is mono LTR and amounts are money family LTR', () => {
    const id = declsFor('v5/void/void.css', '.v5-void-id');
    const money = declsFor('v5/void/void.css', '.v5-void-money');
    const recovery = declsFor('v5/recovery/recovery.css', '.v5-recovery-money');
    for (const decls of [id, money, recovery]) {
      expect(decls.get('direction')).toBe('ltr');
      expect(decls.get('unicode-bidi')).toBe('isolate');
    }
    expect(id.get('font-variant-numeric')).toBe('tabular-nums');
  });
});
