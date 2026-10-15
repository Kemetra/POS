/**
 * RT-530 — shared fixtures for the sale-void tests: one terminal scope, ids,
 * and a builder of journal entries.
 */
import type { NewVoidEntry, VoidScope } from '../../sale-void-repository.js';

export const SCOPE: VoidScope = {
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  terminalId: 'term-1',
};

export const APPROVAL_A = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
export const APPROVAL_B = '0190f5a2-7b3c-7d4e-8f90-0000000000a2';
export const APPROVER_USER = '0190f5a2-7b3c-7d4e-8f90-0000000000b1';
export const REQUESTER_USER = '0190f5a2-7b3c-7d4e-8f90-0000000000b2';
export const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000c1';

/** A void entry for sale `sale-1`; `n` makes the id and the external id unique. */
export function newVoidEntry(n: number, over: Partial<NewVoidEntry> = {}): NewVoidEntry {
  return {
    voidId: `v${String(n)}`,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    externalId: `pos-pulse-void:0190f5a2-7b3c-7d4e-8f90-${String(n).padStart(12, '0')}`,
    approvalId: APPROVAL_A,
    approverUserId: APPROVER_USER,
    requesterUserId: REQUESTER_USER,
    requesterOperatorId: 'op-requester',
    requesterDisplayName: 'Rana Requester',
    operatorSessionId: 'sess-1',
    policyVersion: 'rt114-2026-10-07',
    approvedAt: '2026-06-07T10:05:00.000Z',
    businessDate: '2026-06-07',
    amountMinor: 1500,
    cashMinor: 1500,
    currencyCode: 'EGP',
    now: `2026-06-07T10:06:0${String(n)}.000Z`,
    ...over,
  };
}
