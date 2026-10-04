import { afterEach, describe, expect, it } from 'vitest';
import { useFeatureFlagsStore } from '../feature-flags-store.js';

afterEach(() => {
  useFeatureFlagsStore.getState().reset();
});

describe('feature-flags-store — productSearch (009 T049a)', () => {
  it('defaults productSearch to false (fail-closed)', () => {
    expect(useFeatureFlagsStore.getState().productSearch).toBe(false);
  });

  it('hydrates productSearch from the flag map', () => {
    useFeatureFlagsStore.getState().hydrate({ productSearch: true });
    expect(useFeatureFlagsStore.getState().productSearch).toBe(true);
  });

  it('hydrate without productSearch leaves it false', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true });
    expect(useFeatureFlagsStore.getState().productSearch).toBe(false);
  });

  it('reset restores productSearch to false', () => {
    useFeatureFlagsStore.getState().hydrate({ productSearch: true });
    useFeatureFlagsStore.getState().reset();
    expect(useFeatureFlagsStore.getState().productSearch).toBe(false);
  });
});

describe('feature-flags-store — voucherTender (RT-103, RT-10 D2 pilot rule)', () => {
  it('defaults voucherTender to false (pilot: voucher tender unavailable)', () => {
    expect(useFeatureFlagsStore.getState().voucherTender).toBe(false);
  });

  it('hydrates voucherTender only from an explicit true', () => {
    useFeatureFlagsStore.getState().hydrate({ payments: true });
    expect(useFeatureFlagsStore.getState().voucherTender).toBe(false);
    useFeatureFlagsStore.getState().hydrate({ voucherTender: true });
    expect(useFeatureFlagsStore.getState().voucherTender).toBe(true);
  });

  it('reset restores voucherTender to false', () => {
    useFeatureFlagsStore.getState().hydrate({ voucherTender: true });
    useFeatureFlagsStore.getState().reset();
    expect(useFeatureFlagsStore.getState().voucherTender).toBe(false);
  });
});

describe('feature-flags-store — returns (RT-15 S3, AC1 default off)', () => {
  it('defaults returns to false (fail-closed)', () => {
    expect(useFeatureFlagsStore.getState().returns).toBe(false);
  });

  it('hydrates returns only from an explicit true', () => {
    useFeatureFlagsStore.getState().hydrate({ cart: true });
    expect(useFeatureFlagsStore.getState().returns).toBe(false);
    useFeatureFlagsStore.getState().hydrate({ returns: true });
    expect(useFeatureFlagsStore.getState().returns).toBe(true);
  });

  it('reset restores returns to false', () => {
    useFeatureFlagsStore.getState().hydrate({ returns: true });
    useFeatureFlagsStore.getState().reset();
    expect(useFeatureFlagsStore.getState().returns).toBe(false);
  });
});
