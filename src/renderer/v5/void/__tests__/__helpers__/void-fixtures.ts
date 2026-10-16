/**
 * RT-530 — shared fixtures for the sale void renderer tests: a sale, journal
 * rows, and fake `saleVoid` / `approval` bridges whose every member is a spy
 * with an accepting default answer.
 */
import { vi, type Mock } from 'vitest';

import type { ManagerApprovalBridgeAPI } from '../../../../../shared/operator/manager-approval';
import type {
  SaleVoidBridgeAPI,
  SaleVoidJournalView,
  SaleVoidSaleView,
} from '../../../../../shared/sale-void/types';
import type { VoidBridges } from '../../void-bridges';

export const MANAGER = {
  approver_ref: '7f3c1e2a-0b4d-4c5e-8f60-0000000000aa',
  display_name: 'كريم المدير',
} as const;

export const SALE_NUMBER = 'T1-2026-06-07-000001';

export function saleView(overrides: Partial<SaleVoidSaleView> = {}): SaleVoidSaleView {
  return {
    sale_id: 'sale-1',
    sale_number: SALE_NUMBER,
    finalized_at: '2026-06-07T10:00:00.000Z',
    total_minor: 15_000,
    cash_minor: 15_000,
    selling_operator_display_name: 'رنا الكاشير',
    ineligible: null,
    ...overrides,
  };
}

export function journalView(overrides: Partial<SaleVoidJournalView> = {}): SaleVoidJournalView {
  return {
    void_id: 'void-1',
    sale_number: SALE_NUMBER,
    total_minor: 15_000,
    requested_at: '2026-06-07T10:30:00.000Z',
    state: 'pending',
    requester_display_name: 'منى المديرة',
    waiting_for: null,
    refusal_reason: null,
    needs_attention: false,
    confirmed_at: null,
    ...overrides,
  };
}

export type FakeSaleVoidBridge = { [K in keyof SaleVoidBridgeAPI]: Mock<SaleVoidBridgeAPI[K]> };
export type FakeApprovalBridge = {
  [K in keyof ManagerApprovalBridgeAPI]: Mock<ManagerApprovalBridgeAPI[K]>;
};

export function fakeSaleVoidBridge(
  voids: SaleVoidJournalView[] = [],
  sale: SaleVoidSaleView = saleView(),
): FakeSaleVoidBridge {
  return {
    lookup: vi.fn<SaleVoidBridgeAPI['lookup']>(() => Promise.resolve({ kind: 'sale', sale })),
    request: vi.fn<SaleVoidBridgeAPI['request']>(() =>
      Promise.resolve({ kind: 'requested', void: journalView() }),
    ),
    list: vi.fn<SaleVoidBridgeAPI['list']>(() => Promise.resolve({ kind: 'list', voids })),
    acknowledge: vi.fn<SaleVoidBridgeAPI['acknowledge']>(() =>
      Promise.resolve({ kind: 'acknowledged' }),
    ),
  };
}

export function fakeApprovalBridge(): FakeApprovalBridge {
  return {
    listApprovers: vi.fn<ManagerApprovalBridgeAPI['listApprovers']>(() =>
      Promise.resolve({ kind: 'approvers', approvers: [{ ...MANAGER }] }),
    ),
    request: vi.fn<ManagerApprovalBridgeAPI['request']>(() =>
      Promise.resolve({ kind: 'approved', approval_id: '0190f5a2-3b4c-7d8e-9f01-000000000001' }),
    ),
  };
}

export interface FakeBridges extends VoidBridges {
  saleVoid: FakeSaleVoidBridge;
  approval: FakeApprovalBridge;
}

export function fakeBridges(
  voids: SaleVoidJournalView[] = [],
  sale: SaleVoidSaleView = saleView(),
): FakeBridges {
  return { saleVoid: fakeSaleVoidBridge(voids, sale), approval: fakeApprovalBridge() };
}
