/**
 * RT-441 — shared fixtures for the manager recovery renderer tests: a stuck
 * attempt, held carts, and fake `recovery` / `approval` bridges whose every
 * member is a spy with an accepting default answer.
 */
import { vi, type Mock } from 'vitest';

import type { ListBranchRosterResponse } from '../../../../../shared/bridge-api';
import type { ManagerApprovalBridgeAPI } from '../../../../../shared/operator/manager-approval';
import type {
  RecoveryBridgeAPI,
  RecoveryHeldCartView,
  RecoveryHeldView,
  RecoveryStuckAttemptView,
} from '../../../../../shared/operator/recovery';
import type { RecoveryBridges } from '../../RecoveryScreen';

export const MANAGER = {
  approver_ref: '7f3c1e2a-0b4d-4c5e-8f60-0000000000aa',
  display_name: 'منى المديرة',
} as const;

export const OWNER_ID = 'op-cashier-1';

export function stuckAttempt(
  overrides: Partial<RecoveryStuckAttemptView> = {},
): RecoveryStuckAttemptView {
  return {
    payment_attempt_id: 'attempt-1',
    cart_id: 'cart-stuck',
    owning_operator_id: OWNER_ID,
    line_count: 3,
    total_minor: 15_000,
    cash_minor: 5_000,
    card_minor: 0,
    voucher_minor: 0,
    remaining_minor: 10_000,
    started_at: '2026-10-13T09:00:00.000Z',
    ...overrides,
  };
}

export function heldCart(overrides: Partial<RecoveryHeldCartView> = {}): RecoveryHeldCartView {
  return {
    cart_id: 'cart-held-1',
    owning_operator_id: OWNER_ID,
    kind: 'draft',
    parked: false,
    line_count: 2,
    total_minor: 4_250,
    updated_at: '2026-10-13T08:30:00.000Z',
    ...overrides,
  };
}

export function heldView(overrides: Partial<RecoveryHeldView> = {}): RecoveryHeldView {
  return { kind: 'held', recovery_mode: false, stuck: null, held: [], ...overrides };
}

export type FakeRecoveryBridge = { [K in keyof RecoveryBridgeAPI]: Mock<RecoveryBridgeAPI[K]> };
export type FakeApprovalBridge = {
  [K in keyof ManagerApprovalBridgeAPI]: Mock<ManagerApprovalBridgeAPI[K]>;
};

export function fakeRecoveryBridge(view: RecoveryHeldView = heldView()): FakeRecoveryBridge {
  return {
    listHeld: vi.fn<RecoveryBridgeAPI['listHeld']>(() => Promise.resolve(view)),
    completeAttempt: vi.fn<RecoveryBridgeAPI['completeAttempt']>(() =>
      Promise.resolve({ kind: 'completed', change_due_minor: 0 }),
    ),
    cancelAttempt: vi.fn<RecoveryBridgeAPI['cancelAttempt']>(() =>
      Promise.resolve({ kind: 'cancelled' }),
    ),
    cancelHeldCart: vi.fn<RecoveryBridgeAPI['cancelHeldCart']>(() =>
      Promise.resolve({ kind: 'cancelled' }),
    ),
  };
}

export function fakeApprovalBridge(): FakeApprovalBridge {
  return {
    listApprovers: vi.fn<ManagerApprovalBridgeAPI['listApprovers']>(() =>
      Promise.resolve({ kind: 'approvers', approvers: [{ ...MANAGER }] }),
    ),
    request: vi.fn<ManagerApprovalBridgeAPI['request']>(() =>
      Promise.resolve({ kind: 'approved', approval_id: 'approval-1' }),
    ),
  };
}

export interface FakeBridges extends RecoveryBridges {
  recovery: FakeRecoveryBridge;
  approval: FakeApprovalBridge;
}

export function fakeBridges(
  view: RecoveryHeldView = heldView(),
  roster?: ListBranchRosterResponse,
): FakeBridges {
  return {
    recovery: fakeRecoveryBridge(view),
    approval: fakeApprovalBridge(),
    ...(roster === undefined ? {} : { listRoster: () => Promise.resolve(roster) }),
  };
}

/** The roster the renderer resolves owner names from. */
export function roster(names: Record<string, string>): ListBranchRosterResponse {
  return {
    kind: 'roster',
    cashiers: Object.entries(names).map(([id, display_name]) => ({
      id,
      display_name,
      role: 'cashier' as const,
    })),
  };
}
