import type { AppConfig } from '../../shared/app-config.js';

/**
 * RT-162 (RT-160 FU-1: S-1 config module + H-1 fail-closed cashier profile).
 *
 * The one place the POS feature flags are parsed from the process environment.
 * Previously `src/main/index.ts` `getAppConfig()` repeated the same inline
 * truthy check five times; this module keeps those semantics exactly:
 *
 *   • the env-var names are the ops contract (unchanged);
 *   • truthy values are `1 | true | yes | on`, case-insensitive, trimmed;
 *   • anything else, or unset, is `false` — every flag is fail-closed.
 *
 * It also owns the D-1 cashier-profile rule (owner decision, RT-160 comment
 * 10721): `PAYMENTS` on with `SALE_FINALIZATION` off is an INVALID profile.
 * In that mode 006 settles money while 008 writes no Sale row, receipt, sync
 * outbox entry or Backend-Core capture. Main refuses to start the cashier
 * rather than take money it cannot record. The decision is pure here; the
 * composition root logs it, shows a native dialog and exits.
 *
 * Deliberately NOT here: `SENTRY_DSN`, `POS_PULSE_FEATURE_SALE_TENDERS_SINCE`
 * (an ISO instant with its own parser in `sales-sync`), and the dev-only
 * `POS_PULSE_DEV_*` bypasses (each owns its own packaged-build guard).
 */

/** All five feature flags, always present. Same shape as `AppConfig['features']`. */
export type FeatureFlags = Required<NonNullable<AppConfig['features']>>;

/** Flag → env-var name. The names are the contract for ops scripts. */
export const FEATURE_FLAG_ENV: Readonly<Record<keyof FeatureFlags, string>> = Object.freeze({
  cart: 'POS_PULSE_FEATURE_CART',
  payments: 'POS_PULSE_FEATURE_PAYMENTS',
  saleFinalization: 'POS_PULSE_FEATURE_SALE_FINALIZATION',
  productSearch: 'POS_PULSE_FEATURE_PRODUCT_SEARCH',
  voucherTender: 'POS_PULSE_FEATURE_VOUCHER_TENDER',
});

const TRUTHY_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** The shared truthy parser. Unset or unrecognised → `false` (fail-closed). */
export function isTruthyFlag(raw: string | undefined): boolean {
  return typeof raw === 'string' && TRUTHY_VALUES.has(raw.trim().toLowerCase());
}

/** Parse every feature flag from an environment (normally `process.env`). */
export function parseFeatureFlags(env: Readonly<Record<string, string | undefined>>): FeatureFlags {
  return {
    cart: isTruthyFlag(env[FEATURE_FLAG_ENV.cart]),
    payments: isTruthyFlag(env[FEATURE_FLAG_ENV.payments]),
    saleFinalization: isTruthyFlag(env[FEATURE_FLAG_ENV.saleFinalization]),
    productSearch: isTruthyFlag(env[FEATURE_FLAG_ENV.productSearch]),
    voucherTender: isTruthyFlag(env[FEATURE_FLAG_ENV.voucherTender]),
  };
}

export type CashierProfileRefusalReason = 'payments_without_sale_finalization';

export type CashierProfileAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CashierProfileRefusalReason };

/**
 * D-1 coherence check. Only the money combination is decided here; other
 * combinations (e.g. product search without cart) are UX coherence and keep
 * their existing semantics.
 */
export function assessCashierProfile(flags: FeatureFlags): CashierProfileAssessment {
  if (flags.payments && !flags.saleFinalization) {
    return { ok: false, reason: 'payments_without_sale_finalization' };
  }
  return { ok: true };
}

export interface CashierProfileRefusal {
  readonly title: string;
  readonly body: string;
}

/**
 * Copy for the native startup dialog. Arabic first (the cashier/store reads
 * it), then one technical line naming the env vars for whoever provisions the
 * terminal. Contains no secrets — flag names only.
 */
export function describeCashierProfileRefusal(
  reason: CashierProfileRefusalReason,
): CashierProfileRefusal {
  return CASHIER_PROFILE_REFUSALS[reason];
}

/**
 * Right-to-left mark. The native dialog lays each paragraph out LTR, so a
 * trailing RLM keeps an Arabic line's sentence-final "." inside the RTL run
 * (otherwise it renders at the visual right edge, where the sentence starts).
 */
const RLM = '‏';

const CASHIER_PROFILE_REFUSALS: Readonly<
  Record<CashierProfileRefusalReason, CashierProfileRefusal>
> = {
  payments_without_sale_finalization: {
    title: 'إعداد نقطة البيع غير صالح',
    body: [
      `الدفع مفعّل بينما تسجيل البيع معطّل، فلن يُسجَّل أي بيع ولن يُطبع إيصال.${RLM}`,
      `لن تعمل نقطة البيع بهذا الإعداد. اتصل بمسؤول النظام لتصحيح إعداد الجهاز.${RLM}`,
      '',
      `${FEATURE_FLAG_ENV.payments} is on while ${FEATURE_FLAG_ENV.saleFinalization} is off. ` +
        'Turn both on, or both off to stop POS payment-taking.',
    ].join('\n'),
  },
};
