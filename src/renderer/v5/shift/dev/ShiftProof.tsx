import type { JSX } from 'react';

import type { Role } from '../../../../shared/operator/role';
import type {
  ShiftCashupBridgeAPI,
  ShiftCloseResponse,
  ShiftStatusView,
} from '../../../../shared/shift-cashup/types';
import { AppRouter } from '../../../router';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import {
  installWindowApi,
  operatorBridge,
  pairingBridge,
  readOneFrameProofParams,
} from '../../frame/dev/OneFrameProof';

/**
 * RT-658 — DEV-ONLY shift harness (`#/dev/shift-proof`), the same contract as
 * the RT-445 / RT-604 harnesses: the REAL AppRouter (the cashier's
 * `/app/shift`, the manager's `/app/shift/manager`) against an in-memory
 * `shiftCashup` bridge, so every G-2 reference state can be captured at 1024
 * and 1280 without a device. The bridge keeps state like main's answers do
 * (an open moves to an open shift, a pay-in adds to the totals, a close ends
 * the shift), so interactive states are reached by the capture script
 * pressing the same visible buttons an operator presses. It proves layout and
 * presentation only.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `state` = one of the 20 G-2 reference names
 * (default Open).
 */

export const SHIFT_PROOF_STATES = [
  'Open',
  'OpenInvalid',
  'Opened',
  'Status',
  'PayIn',
  'PayOut',
  'PayOutRefused',
  'Recorded',
  'CloseCount',
  'CloseApproval',
  'Closed',
  'ClosedApproved',
  'ParkedBlocked',
  'Unavailable',
  'MgrOpen',
  'MgrNoShift',
  'MgrStranded',
  'MgrPinSaved',
  'MgrPinError',
  'MgrUnavailable',
] as const;

export type ShiftProofState = (typeof SHIFT_PROOF_STATES)[number];

export function readShiftProofState(): ShiftProofState {
  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('state');
  return SHIFT_PROOF_STATES.find((s) => s === raw) ?? 'Open';
}

/** The G-2 references draw a shift opened today at 08:05 (local time). */
const OPENED_AT = new Date(2026, 9, 17, 8, 5).toISOString();

const MANAGERS = [
  { managerRef: 'proof-manager-1', displayName: 'سارة عبد الحميد' },
  { managerRef: 'proof-manager-2', displayName: 'خالد إبراهيم' },
];

const isManagerState = (state: ShiftProofState): boolean => state.startsWith('Mgr');

/** States that start with no open shift on this terminal. */
const NO_SHIFT: ReadonlySet<ShiftProofState> = new Set([
  'Open',
  'OpenInvalid',
  'Opened',
  'MgrNoShift',
]);

const UNAVAILABLE: ReadonlySet<ShiftProofState> = new Set(['Unavailable', 'MgrUnavailable']);

function counts(state: ShiftProofState): Omit<ShiftStatusView, 'openShift'> {
  const quiet = {
    queue: { pending: 0, waiting: 0, blocked: 0, envelopePending: 0 },
    stranded: { unsyncedFacts: 0, openShifts: 0 },
    pendingDrawerActivity: { refundPayouts: 0, unfinalizedSales: 0 },
    probeRefusals: { payOut: 0, varianceClose: 0, approverFailure: 0 },
  };
  if (state === 'MgrNoShift') return quiet;
  if (state === 'MgrStranded') {
    return {
      ...quiet,
      queue: { ...quiet.queue, blocked: 1 },
      stranded: { unsyncedFacts: 3, openShifts: 1 },
    };
  }
  return {
    ...quiet,
    queue: { ...quiet.queue, pending: 2 },
    probeRefusals: { ...quiet.probeRefusals, varianceClose: 1 },
  };
}

/** How main answers a close in this state: with or without a manager's approval. */
function closeAnswer(state: ShiftProofState, approved: boolean): ShiftCloseResponse {
  if (state === 'ParkedBlocked') {
    return { kind: 'refused', reason: 'parked_sales_present', parkedCount: 3 };
  }
  if (state === 'Closed') return { kind: 'closed', shiftId: 'shift-proof', closedAt: OPENED_AT };
  if (!approved) return { kind: 'refused', reason: 'variance_approval_required' };
  return { kind: 'closed', shiftId: 'shift-proof', closedAt: OPENED_AT, varianceMinor: -2_500 };
}

/** An in-memory bridge that keeps state the way main's answers do. */
export function makeShiftProofBridge(state: ShiftProofState): ShiftCashupBridgeAPI {
  const shift = {
    open: !NO_SHIFT.has(state),
    floatMinor: 50_000,
    payInMinor: 20_000,
    payOutMinor: 125_000,
  };
  const view = (): ShiftStatusView => ({
    openShift: shift.open
      ? {
          shiftId: 'shift-proof',
          openedAt: OPENED_AT,
          currencyCode: 'EGP',
          openingFloatMinor: shift.floatMinor,
          payInTotalMinor: shift.payInMinor,
          payOutTotalMinor: shift.payOutMinor,
        }
      : null,
    ...counts(state),
  });
  return {
    status: () =>
      Promise.resolve(
        UNAVAILABLE.has(state)
          ? { kind: 'refused', reason: 'unavailable' }
          : { kind: 'status', status: view() },
      ),
    open: (request) => {
      Object.assign(shift, {
        open: true,
        floatMinor: request.openingFloatMinor,
        payInMinor: 0,
        payOutMinor: 0,
      });
      return Promise.resolve({ kind: 'opened', shiftId: 'shift-proof', openedAt: OPENED_AT });
    },
    payIn: (request) => {
      shift.payInMinor += request.amountMinor;
      return Promise.resolve({ kind: 'recorded', movementId: 'proof-in', shiftId: 'shift-proof' });
    },
    payOut: (request) => {
      if (state === 'PayOutRefused') {
        return Promise.resolve({ kind: 'refused', reason: 'pay_out_not_accepted' });
      }
      shift.payOutMinor += request.amountMinor;
      return Promise.resolve({ kind: 'recorded', movementId: 'proof-out', shiftId: 'shift-proof' });
    },
    close: (request) => {
      const answer = closeAnswer(state, request.approver !== undefined);
      if (answer.kind === 'closed') shift.open = false;
      return Promise.resolve(answer);
    },
    listEnrolledManagers: () => Promise.resolve({ kind: 'managers', managers: MANAGERS }),
    enrollManagerPin: () => Promise.resolve({ kind: 'enrolled' }),
    revokeManagerPin: () => Promise.resolve({ kind: 'revoked' }),
  };
}

const PEOPLE: Readonly<Record<'cashier' | 'manager', { name: string; role: Role }>> = {
  cashier: { name: 'منى عادل', role: 'cashier' },
  manager: { name: 'سارة عبد الحميد', role: 'manager' },
};

export function ShiftProof(): JSX.Element {
  const state = readShiftProofState();
  const who = PEOPLE[isManagerState(state) ? 'manager' : 'cashier'];
  const params = { ...readOneFrameProofParams(), role: who.role };
  installWindowApi(params, { shiftCashup: makeShiftProofBridge(state) });
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, shiftCashup: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `proof-${who.role}`,
    operator_id: `op-${who.role}`,
    display_name: who.name,
    role: who.role,
    tenant_id: '7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77',
    branch_id: 'b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13',
    started_at: OPENED_AT,
  });
  return (
    <AppRouter
      pairing={pairingBridge}
      operator={operatorBridge(params)}
      initialEntry={isManagerState(state) ? '/app/shift/manager' : '/app/shift'}
    />
  );
}
