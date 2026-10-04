import { create } from 'zustand';

/**
 * 005-sales-cart T001 — renderer-side feature flags store.
 *
 * Mirrors `AppConfig.features` (`src/shared/app-config.ts`). Populated
 * once at renderer boot from `window.api.appConfig()`; never mutated
 * afterwards in production. Test-only `set` is exposed for unit/integration
 * tests via `useFeatureFlagsStore.setState({ ... })`.
 *
 * Defaults are fail-closed — every flag starts as `false`. The cart flag
 * enables the Sale cart at /app/cart. Flipping it in production
 * is a §A5 sign-off.
 */
export interface FeatureFlagsState {
  cart: boolean;
  /** 006-payments-tender S1: enables PaymentSurface. Fail-closed default: false. */
  payments: boolean;
  /** 008-sale-finalization-and-receipts T002: enables 008 finalize listener + receipts UI. Fail-closed default: false. */
  saleFinalization: boolean;
  /** 009-product-search-and-barcode-lookup T049a: enables the catalogue search/scan/add surface. Fail-closed default: false. */
  productSearch: boolean;
  /**
   * RT-103: enables the internal voucher tender at checkout. Fail-closed default:
   * false — vouchers are excluded from the pilot (RT-10 D2).
   */
  voucherTender: boolean;
  /**
   * RT-15 S3: enables the manager/admin return flow at /app/returns.
   * Fail-closed default: false (AC1). Main gates every `returns.*` call too.
   */
  returns: boolean;
  /** Whether the flag map has been hydrated from main (vs. boot defaults). */
  hydrated: boolean;
}

export interface FeatureFlagsStore extends FeatureFlagsState {
  hydrate(flags: {
    cart?: boolean;
    payments?: boolean;
    saleFinalization?: boolean;
    productSearch?: boolean;
    voucherTender?: boolean;
    returns?: boolean;
  }): void;
  reset(): void;
}

const INITIAL: FeatureFlagsState = {
  cart: false,
  payments: false,
  saleFinalization: false,
  productSearch: false,
  voucherTender: false,
  returns: false,
  hydrated: false,
};

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  ...INITIAL,
  hydrate: (flags) => {
    set({
      cart: flags.cart === true,
      payments: flags.payments === true,
      saleFinalization: flags.saleFinalization === true,
      productSearch: flags.productSearch === true,
      voucherTender: flags.voucherTender === true,
      returns: flags.returns === true,
      hydrated: true,
    });
  },
  reset: () => {
    set({ ...INITIAL });
  },
}));
