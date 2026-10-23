import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';

import type { ListBranchRosterResponse } from '../../../../shared/bridge-api';
import type {
  ManagerApprovalBridgeAPI,
  ManagerApprovalResponse,
  ManagerApproversResponse,
} from '../../../../shared/operator/manager-approval';
import type {
  RecoveryBridgeAPI,
  RecoveryHeldCartView,
  RecoveryHeldView,
  RecoveryListHeldResponse,
  RecoveryStuckAttemptView,
} from '../../../../shared/operator/recovery';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { V5Frame } from '../../frame/V5Frame';
import { RecoveryScreen, type RecoveryBridges } from '../RecoveryScreen';

/**
 * RT-441 — DEV-ONLY Manager → المبيعات المعلقة harness (`#/dev/recovery-proof`),
 * the same contract as the RT-243 / RT-244 / RT-424 harnesses: the REAL
 * `RecoveryScreen` inside the REAL `V5Frame`, against in-memory recovery and
 * approval bridges, so every state can be captured at 1024 and 1280 without a
 * backend. It proves layout and presentation only: no main process, PIN store,
 * payment FSM or approval service runs here. The packaged bench (RT-446)
 * remains the acceptance evidence.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `view` = typical | recovery | long | empty | refused
 * (default typical); `approver` = ok | none | locked (what `listApprovers`
 * answers; default ok); `approval` = ok | wrong_pin (what `request` answers;
 * default ok).
 */

export interface RecoveryProofParams {
  view: 'typical' | 'recovery' | 'long' | 'empty' | 'refused';
  approver: 'ok' | 'none' | 'locked';
  approval: 'ok' | 'wrong_pin';
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback;
}

export function readRecoveryProofParams(): RecoveryProofParams {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return {
    view: oneOf(params.get('view'), ['typical', 'recovery', 'long', 'empty', 'refused'], 'typical'),
    approver: oneOf(params.get('approver'), ['ok', 'none', 'locked'], 'ok'),
    approval: oneOf(params.get('approval'), ['ok', 'wrong_pin'], 'ok'),
  };
}

const NAMES: Readonly<Record<string, string>> = {
  'op-ahmed': 'أحمد سمير',
  'op-mona': 'منى عبد الرحمن',
  'op-yasmin': 'ياسمين خالد',
  'op-long-1': 'عبد الرحمن مصطفى السيد عبد الفتاح الشناوي',
  'op-long-2': 'محمد عبد الرحمن مصطفى السيد عبد الفتاح الشناوي الدمياطي',
  'op-karim': 'كريم فتحي',
  'op-noha': 'نورهان إبراهيم',
};

const STARTED = '2026-10-13T09:00:00.000Z';

function stuck(overrides: Partial<RecoveryStuckAttemptView> = {}): RecoveryStuckAttemptView {
  return {
    payment_attempt_id: 'proof-attempt',
    cart_id: 'proof-cart-stuck',
    owning_operator_id: 'op-ahmed',
    line_count: 4,
    total_minor: 15_000,
    cash_minor: 5_000,
    card_minor: 0,
    voucher_minor: 0,
    remaining_minor: 10_000,
    started_at: STARTED,
    ...overrides,
  };
}

function held(
  cart_id: string,
  owning_operator_id: string,
  rest: Partial<RecoveryHeldCartView> = {},
): RecoveryHeldCartView {
  return {
    cart_id,
    owning_operator_id,
    kind: 'draft',
    parked: false,
    own: false,
    line_count: 3,
    total_minor: 4_250,
    updated_at: STARTED,
    ...rest,
  };
}

const TYPICAL_HELD: RecoveryHeldCartView[] = [
  held('proof-held-1', 'op-mona'),
  held('proof-held-2', 'op-yasmin', { kind: 'handed_off', line_count: 7, total_minor: 31_975 }),
  held('proof-held-3', 'op-karim', { parked: true, line_count: 1, total_minor: 1_200 }),
  held('proof-held-4', 'op-gone', { line_count: 2, total_minor: 890 }),
];

const LONG_HELD: RecoveryHeldCartView[] = [
  held('proof-long-1', 'op-long-1', { parked: true, line_count: 12, total_minor: 128_450 }),
  held('proof-long-2', 'op-long-2', { kind: 'handed_off', line_count: 3, total_minor: 9_900 }),
  ...TYPICAL_HELD,
  held('proof-long-3', 'op-noha', { line_count: 5, total_minor: 2_340 }),
  held('proof-long-4', 'op-long-1', { kind: 'handed_off', parked: true, total_minor: 75_000 }),
  held('proof-long-5', 'op-ahmed', { line_count: 9, total_minor: 18_000 }),
];

function seed(view: RecoveryProofParams['view']): RecoveryHeldView {
  const base: RecoveryHeldView = { kind: 'held', recovery_mode: false, stuck: null, held: [] };
  if (view === 'typical') return { ...base, stuck: stuck(), held: TYPICAL_HELD };
  if (view === 'recovery') {
    return {
      ...base,
      recovery_mode: true,
      stuck: stuck({ card_minor: 7_000, voucher_minor: 900, remaining_minor: 2_100 }),
    };
  }
  if (view === 'long') return { ...base, held: LONG_HELD };
  return base;
}

/** In-memory recovery + approval bridges: a completed or cancelled subject leaves the list. */
export function makeRecoveryProofBridges(params: RecoveryProofParams): RecoveryBridges {
  let view = seed(params.view);
  const listHeld = (): RecoveryListHeldResponse =>
    params.view === 'refused' ? { kind: 'refused', reason: 'role_mismatch' } : view;
  const clearStuck = (): void => {
    view = { ...view, stuck: null, recovery_mode: false };
  };
  const recovery: RecoveryBridgeAPI = {
    listHeld: () => Promise.resolve(listHeld()),
    completeAttempt: (req) => {
      const remaining = view.stuck?.remaining_minor ?? 0;
      clearStuck();
      const change = Math.max(0, (req.cash_received_minor ?? 0) - remaining);
      return Promise.resolve({ kind: 'completed', change_due_minor: change });
    },
    cancelAttempt: () => {
      clearStuck();
      return Promise.resolve({ kind: 'cancelled' });
    },
    cancelHeldCart: (req) => {
      view = { ...view, held: view.held.filter((c) => c.cart_id !== req.cart_id) };
      return Promise.resolve({ kind: 'cancelled' });
    },
  };
  const approvers = (): ManagerApproversResponse => {
    if (params.approver === 'locked') return { kind: 'refused', reason: 'session_locked' };
    const approver = { approver_ref: 'proof-approver', display_name: 'سارة عبد الحميد' };
    return { kind: 'approvers', approvers: params.approver === 'none' ? [] : [approver] };
  };
  const decide = (): ManagerApprovalResponse =>
    params.approval === 'wrong_pin'
      ? { kind: 'refused', reason: 'approval_unavailable' }
      : { kind: 'approved', approval_id: 'proof-approval' };
  const approval: ManagerApprovalBridgeAPI = {
    listApprovers: () => Promise.resolve(approvers()),
    request: () => Promise.resolve(decide()),
  };
  const roster: ListBranchRosterResponse = {
    kind: 'roster',
    cashiers: Object.entries(NAMES).map(([id, display_name]) => ({
      id,
      display_name,
      role: 'cashier' as const,
    })),
  };
  return { recovery, approval, listRoster: () => Promise.resolve(roster) };
}

let prepared: RecoveryBridges | null = null;

/** Seeds the session once, before the first render (module state: the harness is one page). */
function prepare(): RecoveryBridges {
  if (prepared !== null) return prepared;
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'dev-session',
        operator_id: 'dev-manager',
        display_name: 'سارة عبد الحميد',
        role: 'manager',
        tenant_id: 'dev-tenant',
        branch_id: 'dev-branch',
        started_at: new Date().toISOString(),
      },
    },
  });
  prepared = makeRecoveryProofBridges(readRecoveryProofParams());
  return prepared;
}

/** Tests only: forget the seeded page so the next render reads the hash again. */
export function resetRecoveryProofForTests(): void {
  prepared = null;
}

export function RecoveryProof(): JSX.Element {
  const bridges = prepare();
  return (
    <MemoryRouter initialEntries={['/app/manager/recovery']}>
      <V5Frame>
        <RecoveryScreen bridges={bridges} />
      </V5Frame>
    </MemoryRouter>
  );
}
