import type { JSX } from 'react';

import type {
  ManagerApprovalBridgeAPI,
  ManagerApprovalResponse,
  ManagerApproversResponse,
} from '../../../../shared/operator/manager-approval';
import type {
  SaleVoidBridgeAPI,
  SaleVoidJournalView,
  SaleVoidListResponse,
  SaleVoidLookupResponse,
  SaleVoidSaleView,
} from '../../../../shared/sale-void/types';
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
 * RT-654 — DEV-ONLY void screen harness (`#/dev/void-proof`), the same contract
 * as the RT-445 / RT-604 harnesses: the REAL AppRouter at `/app/void` inside the
 * V5 frame against in-memory `saleVoid` / `approval` bridges, so every VD-Void
 * reference state can be captured at 1024 and 1280 without a backend. It proves
 * layout and presentation only.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `state` = one of the 12 VD-Void reference names
 * (default Lookup). Interactive states (the found sale, the dialog) are reached
 * by the capture script pressing the same visible controls a manager presses.
 * The data is fictional, as in the references; times carry the Cairo offset,
 * so the capture runs with `timezoneId: 'Africa/Cairo'`.
 */

export const VOID_PROOF_STATES = [
  'Lookup',
  'Journal',
  'Found',
  'Requested',
  'RefNotFound',
  'RefIneligible',
  'RefJournal',
  'RefServer',
  'Dialog',
  'DialogReady',
  'DialogRefused',
  'DialogNoManagers',
] as const;
export type VoidProofState = (typeof VOID_PROOF_STATES)[number];

export function readVoidProofState(): VoidProofState {
  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('state');
  return VOID_PROOF_STATES.find((s) => s === raw) ?? 'Lookup';
}

const MANAGER = 'سارة عبد الحميد';
const CASHIER = 'منى عبد الرحمن';

const SALE: SaleVoidSaleView = {
  sale_id: 'proof-sale-51',
  sale_number: 'TERM-01-2026-10-17-000051',
  finalized_at: '2026-10-17T10:58:00+03:00',
  total_minor: 31_250,
  cash_minor: 31_250,
  selling_operator_display_name: CASHIER,
  ineligible: null,
};

const OLD_SALE: SaleVoidSaleView = {
  ...SALE,
  sale_id: 'proof-sale-118',
  sale_number: 'TERM-01-2026-10-16-000118',
  finalized_at: '2026-10-16T19:24:00+03:00',
  total_minor: 8_500,
  cash_minor: 8_500,
  ineligible: 'not_same_day',
};

/** [number suffix, total minor, requested hh:mm, state, extras] */
type Row = readonly [
  string,
  number,
  string,
  SaleVoidJournalView['state'],
  Partial<SaleVoidJournalView>?,
];

function entry([suffix, total, at, state, extra = {}]: Row): SaleVoidJournalView {
  return {
    void_id: `proof-void-${suffix}`,
    sale_number: `TERM-01-2026-10-17-${suffix}`,
    total_minor: total,
    requested_at: `2026-10-17T${at}:00+03:00`,
    state,
    requester_display_name: MANAGER,
    waiting_for: null,
    refusal_reason: null,
    needs_attention: false,
    confirmed_at: null,
    ...extra,
  };
}

const JOURNAL: SaleVoidJournalView[] = [
  entry(['000049', 4_500, '11:42', 'pending', { waiting_for: 'sale_sync' }]),
  entry([
    '000047',
    124_000,
    '11:20',
    'pending',
    { waiting_for: 'requester_sign_in', requester_display_name: CASHIER },
  ]),
  entry(['000039', 18_750, '10:05', 'unknown']),
  entry(['000022', 4_675, '09:31', 'confirmed', { confirmed_at: '2026-10-17T09:40:00+03:00' }]),
];

const REFUSED = entry([
  '000044',
  19_000,
  '11:02',
  'refused',
  { refusal_reason: 'void_self_approval', needs_attention: true },
]);

/** The journal before any action in this state. */
function journalFor(state: VoidProofState): SaleVoidJournalView[] {
  if (state === 'Lookup') return [];
  if (state === 'RefServer') return [REFUSED, ...JOURNAL];
  return JOURNAL;
}

function lookupFor(state: VoidProofState): SaleVoidLookupResponse {
  if (state === 'RefNotFound') return { kind: 'refused', reason: 'sale_not_found' };
  return { kind: 'sale', sale: state === 'RefIneligible' ? OLD_SALE : SALE };
}

function saleVoidBridge(state: VoidProofState): SaleVoidBridgeAPI {
  let voids = journalFor(state);
  const list = (): Promise<SaleVoidListResponse> =>
    state === 'RefJournal'
      ? Promise.resolve({ kind: 'refused', reason: 'void_unavailable' })
      : Promise.resolve({ kind: 'list', voids });
  return {
    lookup: () => Promise.resolve(lookupFor(state)),
    list,
    request: () => {
      const requested = entry([
        '000051',
        SALE.total_minor,
        '11:48',
        'pending',
        { waiting_for: 'sale_sync' },
      ]);
      voids = [requested, ...voids];
      return Promise.resolve({ kind: 'requested', void: requested });
    },
    acknowledge: () => Promise.resolve({ kind: 'acknowledged' }),
  };
}

function approvalBridge(state: VoidProofState): ManagerApprovalBridgeAPI {
  const approvers: ManagerApproversResponse =
    state === 'DialogNoManagers'
      ? { kind: 'approvers', approvers: [] }
      : {
          kind: 'approvers',
          approvers: [
            { approver_ref: 'proof-approver-1', display_name: 'خالد منصور' },
            { approver_ref: 'proof-approver-2', display_name: 'هبة الشافعي' },
          ],
        };
  const answer: ManagerApprovalResponse =
    state === 'DialogRefused'
      ? { kind: 'refused', reason: 'approval_unavailable' }
      : { kind: 'approved', approval_id: 'proof-approval' };
  return {
    listApprovers: () => Promise.resolve(approvers),
    request: () => Promise.resolve(answer),
  };
}

export function VoidProof(): JSX.Element {
  const state = readVoidProofState();
  const params = { ...readOneFrameProofParams(), path: '/app/void', role: 'manager' as const };
  installWindowApi(params, { saleVoid: saleVoidBridge(state), approval: approvalBridge(state) });
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    productSearch: true,
    saleVoid: true,
  });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'proof-manager',
    operator_id: 'op-manager',
    display_name: MANAGER,
    role: 'manager',
    tenant_id: '7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77',
    branch_id: 'b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13',
    started_at: '2026-10-17T08:00:00+03:00',
  });
  return (
    <AppRouter pairing={pairingBridge} operator={operatorBridge(params)} initialEntry="/app/void" />
  );
}
