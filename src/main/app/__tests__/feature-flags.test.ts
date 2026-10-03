import { describe, it, expect } from 'vitest';

import {
  FEATURE_FLAG_ENV,
  assessCashierProfile,
  describeCashierProfileRefusal,
  isTruthyFlag,
  parseFeatureFlags,
  type FeatureFlags,
} from '../feature-flags.js';

/**
 * RT-162 (RT-160 FU-1 / S-1 + H-1) — feature-flag config module.
 *
 * The first two blocks CHARACTERISE the parsing that previously lived inline in
 * `src/main/index.ts` `getAppConfig()` (five copies of
 * `typeof raw === 'string' && ['1','true','yes','on'].includes(raw.trim().toLowerCase())`).
 * They must stay green with no semantic drift: same env names, same truthy set,
 * same fail-closed default.
 *
 * The last blocks cover the D-1 cashier-profile rule: PAYMENTS on with
 * SALE_FINALIZATION off is an invalid profile (money would settle with no Sale
 * row, receipt, outbox entry or Backend-Core capture).
 */

describe('isTruthyFlag (characterises the pre-RT-162 inline parser)', () => {
  it.each(['1', 'true', 'yes', 'on'])('treats %j as enabled', (raw) => {
    expect(isTruthyFlag(raw)).toBe(true);
  });

  it.each(['TRUE', 'Yes', 'ON', ' On ', '\ttrue\n', ' 1 '])(
    'is case-insensitive and trims whitespace (%j)',
    (raw) => {
      expect(isTruthyFlag(raw)).toBe(true);
    },
  );

  it.each(['', ' ', '0', 'false', 'no', 'off', 'y', 't', 'enabled', '2', 'true1', 'o n'])(
    'treats %j as disabled',
    (raw) => {
      expect(isTruthyFlag(raw)).toBe(false);
    },
  );

  it('treats an unset variable as disabled (fail-closed default)', () => {
    expect(isTruthyFlag(undefined)).toBe(false);
  });
});

describe('parseFeatureFlags', () => {
  it('maps each flag to its existing env-var contract', () => {
    expect(FEATURE_FLAG_ENV).toEqual({
      cart: 'POS_PULSE_FEATURE_CART',
      payments: 'POS_PULSE_FEATURE_PAYMENTS',
      saleFinalization: 'POS_PULSE_FEATURE_SALE_FINALIZATION',
      productSearch: 'POS_PULSE_FEATURE_PRODUCT_SEARCH',
      voucherTender: 'POS_PULSE_FEATURE_VOUCHER_TENDER',
    });
  });

  it('defaults every flag to false when nothing is set', () => {
    expect(parseFeatureFlags({})).toEqual({
      cart: false,
      payments: false,
      saleFinalization: false,
      productSearch: false,
      voucherTender: false,
    });
  });

  it('always returns all five keys as booleans', () => {
    const flags = parseFeatureFlags({ POS_PULSE_FEATURE_CART: 'nonsense' });
    expect(Object.keys(flags).sort()).toEqual(
      ['cart', 'payments', 'productSearch', 'saleFinalization', 'voucherTender'].sort(),
    );
    for (const value of Object.values(flags)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('reads each flag independently from its own env var', () => {
    for (const [key, envName] of Object.entries(FEATURE_FLAG_ENV)) {
      const flags = parseFeatureFlags({ [envName]: 'on' });
      for (const [otherKey, value] of Object.entries(flags)) {
        expect(value).toBe(otherKey === key);
      }
    }
  });

  it('parses a full pilot cashier profile', () => {
    expect(
      parseFeatureFlags({
        POS_PULSE_FEATURE_CART: '1',
        POS_PULSE_FEATURE_PAYMENTS: 'true',
        POS_PULSE_FEATURE_SALE_FINALIZATION: 'YES',
        POS_PULSE_FEATURE_PRODUCT_SEARCH: ' on ',
        POS_PULSE_FEATURE_VOUCHER_TENDER: '',
      }),
    ).toEqual({
      cart: true,
      payments: true,
      saleFinalization: true,
      productSearch: true,
      voucherTender: false,
    });
  });

  it('ignores unrelated env vars', () => {
    expect(
      parseFeatureFlags({ POS_PULSE_FEATURE_SALE_TENDERS_SINCE: '1', CART: '1', PAYMENTS: '1' }),
    ).toEqual(parseFeatureFlags({}));
  });
});

/** Every one of the 32 combinations of the five boolean flags. */
function allFlagCombinations(): FeatureFlags[] {
  const keys = Object.keys(FEATURE_FLAG_ENV) as (keyof FeatureFlags)[];
  const out: FeatureFlags[] = [];
  for (let mask = 0; mask < 1 << keys.length; mask += 1) {
    const flags = {} as Record<keyof FeatureFlags, boolean>;
    keys.forEach((key, i) => {
      flags[key] = (mask & (1 << i)) !== 0;
    });
    out.push(flags);
  }
  return out;
}

/** The H-2 pilot cashier profile: CART, PAYMENTS, SALE_FINALIZATION, PRODUCT_SEARCH on; VOUCHER off. */
const PILOT_PROFILE: FeatureFlags = {
  cart: true,
  payments: true,
  saleFinalization: true,
  productSearch: true,
  voucherTender: false,
};

describe('assessCashierProfile (D-1: fail closed on the money combination)', () => {
  it.each<[string, FeatureFlags, ReturnType<typeof assessCashierProfile>]>([
    [
      'rejects PAYMENTS on with SALE_FINALIZATION off',
      { ...PILOT_PROFILE, saleFinalization: false },
      { ok: false, reason: 'payments_without_sale_finalization' },
    ],
    ['accepts the normal pilot profile (both flags on)', PILOT_PROFILE, { ok: true }],
    [
      'accepts the all-off default (fail-closed defaults stay launchable)',
      parseFeatureFlags({}),
      { ok: true },
    ],
    [
      'accepts the D-1 contingency rollback (PAYMENTS and SALE_FINALIZATION both off)',
      { ...PILOT_PROFILE, payments: false, saleFinalization: false },
      { ok: true },
    ],
  ])('%s', (_label, flags, expected) => {
    expect(assessCashierProfile(flags)).toEqual(expected);
  });

  it('rejects exactly the 8 of 32 combinations with payments on and finalization off', () => {
    const combos = allFlagCombinations();
    expect(combos).toHaveLength(32);
    const rejected = combos.filter((flags) => !assessCashierProfile(flags).ok);
    expect(rejected).toHaveLength(8);
    for (const flags of combos) {
      const expectedOk = !(flags.payments && !flags.saleFinalization);
      expect(assessCashierProfile(flags).ok).toBe(expectedOk);
    }
  });
});

describe('describeCashierProfileRefusal', () => {
  it('names both env vars so ops can correct the terminal', () => {
    const refusal = describeCashierProfileRefusal('payments_without_sale_finalization');
    expect(refusal.title.length).toBeGreaterThan(0);
    expect(refusal.body).toContain('POS_PULSE_FEATURE_PAYMENTS');
    expect(refusal.body).toContain('POS_PULSE_FEATURE_SALE_FINALIZATION');
  });

  it('leads with Arabic copy (Arabic-first product)', () => {
    const refusal = describeCashierProfileRefusal('payments_without_sale_finalization');
    expect(refusal.title).toMatch(/[؀-ۿ]/);
    expect(refusal.body.split('\n')[0]).toMatch(/[؀-ۿ]/);
  });

  it('ends each Arabic line with an RLM so the full stop stays in the RTL run', () => {
    // Win32 message boxes lay paragraphs out LTR; without a trailing RLM the
    // sentence-final "." is resolved LTR and drifts to the visual right edge.
    const refusal = describeCashierProfileRefusal('payments_without_sale_finalization');
    const arabicLines = refusal.body.split('\n').filter((line) => /[؀-ۿ]/.test(line));
    expect(arabicLines.length).toBeGreaterThan(0);
    for (const line of arabicLines) {
      expect(line.endsWith('.‏')).toBe(true);
    }
  });
});
