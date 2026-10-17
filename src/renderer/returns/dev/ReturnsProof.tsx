import type { JSX } from 'react';

import type {
  ReturnJournalView,
  ReturnsBridgeAPI,
  ReturnsListResponse,
  ReturnsLookupResponse,
  ReturnsPayoutResponse,
  ReturnsQuoteResponse,
  ReturnsReprintResponse,
  ReturnsSubmitResponse,
} from '../../../shared/returns/types';
import { AppRouter } from '../../router';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import {
  installWindowApi,
  operatorBridge,
  pairingBridge,
  readOneFrameProofParams,
} from '../../v5/frame/dev/OneFrameProof';
import {
  FULL_JOURNAL,
  PROOF_QUOTE,
  PROOF_SALE,
  SHORT_JOURNAL,
  STARTED,
  paidPayout,
  submittedReturn,
} from './returns-proof-data';

/**
 * RT-660 — DEV-ONLY Returns harness (`#/dev/returns-proof`), the same contract
 * as the RT-445 / RT-498 harnesses: the REAL AppRouter at `/app/returns` (the
 * shipped RT-15 screen) against an in-memory returns bridge scripted per
 * state, so every G6R reference state can be captured at 1024 and 1280
 * without a backend. It proves layout and presentation only.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `state` = one of the G6R reference names (default
 * LookupEmpty). The flow steps (lookup, pick, quote, confirm, pay out) are
 * reached by the capture script pressing the same visible controls a manager
 * presses; the bridge only decides what main answers.
 */
export const RETURNS_PROOF_STATES = [
  'LookupEmpty',
  'LookupBlank',
  'LookupNotFound',
  'LookupRefused',
  'LookupOffline',
  'Found',
  'SelectPicked',
  'SelectQuoting',
  'SelectRefused',
  'Quote',
  'OutcomeUnconfirmed',
  'OutcomeRefused',
  'OutcomeFailed',
  'OutcomeMayBeRecorded',
  'PayoutReady',
  'PayoutOpening',
  'PayoutPaid',
  'PayoutNoDrawer',
  'PayoutSlipFailed',
  'PayoutReprintFailed',
  'PayoutDrawerFailed',
  'PayoutDrawerUnknown',
  'PayoutConfirmManual',
  'PayoutInterrupted',
  'PayoutWait',
  'PayoutRefused',
  'PayoutUnknown',
  'HistoryEmpty',
  'HistoryRows',
  'HistoryReprintFailed',
  'HistoryFailed',
  'Disabled',
] as const;
export type ReturnsProofState = (typeof RETURNS_PROOF_STATES)[number];

export function readReturnsProofState(): ReturnsProofState {
  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('state');
  return RETURNS_PROOF_STATES.find((s) => s === raw) ?? 'LookupEmpty';
}

/** An answer that never comes: the step stays in flight (Quoting, Opening). */
const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
const fails = <T,>(): Promise<T> => Promise.reject(new Error('proof: transport failure'));

type ByState<T> = { readonly [K in ReturnsProofState]?: () => Promise<T> };

const LOOKUP: ByState<ReturnsLookupResponse> = {
  LookupNotFound: () => Promise.resolve({ kind: 'refused', reason: 'sale_not_found' }),
  LookupRefused: () => Promise.resolve({ kind: 'refused', reason: 'card_tender_blocked' }),
  LookupOffline: () => Promise.resolve({ kind: 'refused', reason: 'offline' }),
};

const QUOTE: ByState<ReturnsQuoteResponse> = {
  SelectQuoting: never,
  SelectRefused: () => Promise.resolve({ kind: 'refused', reason: 'quantity_out_of_range' }),
};

const SUBMIT: ByState<ReturnsSubmitResponse> = {
  OutcomeUnconfirmed: () =>
    Promise.resolve({
      kind: 'unconfirmed',
      ret: { ...submittedReturn(), state: 'unknown', returnRef: null },
    }),
  OutcomeRefused: () =>
    Promise.resolve({
      kind: 'refused',
      reason: 'over_return',
      ret: { ...submittedReturn(), state: 'refused', returnRef: null },
    }),
  OutcomeFailed: fails,
  OutcomeMayBeRecorded: () =>
    Promise.resolve({ kind: 'refused', reason: 'session_changed', ret: null }),
  PayoutInterrupted: () =>
    Promise.resolve({ kind: 'confirmed', ret: submittedReturn(STARTED), replayed: false }),
};

function paidOut(method: 'drawer' | 'no_drawer', slip: 'printed' | 'failed') {
  return (): Promise<ReturnsPayoutResponse> =>
    Promise.resolve({
      kind: 'paid_out',
      ret: { ...submittedReturn(paidPayout(method)), state: 'paid_out' },
      method,
      slip,
    });
}

function drawerFailed(reason: 'no_drawer_configured' | 'timeout') {
  return (): Promise<ReturnsPayoutResponse> =>
    Promise.resolve({ kind: 'drawer_failed', ret: submittedReturn(STARTED), reason });
}

const PAYOUT: ByState<ReturnsPayoutResponse> = {
  PayoutOpening: never,
  PayoutPaid: paidOut('drawer', 'printed'),
  PayoutNoDrawer: paidOut('no_drawer', 'printed'),
  PayoutSlipFailed: paidOut('drawer', 'failed'),
  PayoutReprintFailed: paidOut('drawer', 'printed'),
  // Only a kick that provably never left may be retried (P1): no drawer configured.
  PayoutDrawerFailed: drawerFailed('no_drawer_configured'),
  PayoutDrawerUnknown: drawerFailed('timeout'),
  PayoutConfirmManual: drawerFailed('no_drawer_configured'),
  PayoutWait: () =>
    Promise.resolve({ kind: 'refused', reason: 'another_payout_in_progress', ret: null }),
  PayoutRefused: () => Promise.resolve({ kind: 'refused', reason: 'already_paid_out', ret: null }),
  PayoutUnknown: fails,
};

const REPRINT: ByState<ReturnsReprintResponse> = {
  PayoutReprintFailed: () => Promise.resolve({ kind: 'print_failed' }),
  HistoryReprintFailed: () => Promise.resolve({ kind: 'print_failed' }),
};

function journalFor(state: ReturnsProofState): readonly ReturnJournalView[] {
  if (state === 'HistoryEmpty') return [];
  if (state === 'HistoryRows' || state === 'HistoryReprintFailed') return FULL_JOURNAL;
  return SHORT_JOURNAL;
}

const LIST: ByState<ReturnsListResponse> = { HistoryFailed: fails };

/** The returns namespace the harness installs for `state` (exported for its tests). */
export function returnsProofBridge(state: ReturnsProofState): ReturnsBridgeAPI {
  return {
    lookup: () => (LOOKUP[state] ?? (() => Promise.resolve({ kind: 'ok', sale: PROOF_SALE })))(),
    quote: () => (QUOTE[state] ?? (() => Promise.resolve({ kind: 'ok', quote: PROOF_QUOTE })))(),
    submit: () =>
      (
        SUBMIT[state] ??
        (() => Promise.resolve({ kind: 'confirmed', ret: submittedReturn(), replayed: false }))
      )(),
    resolve: () => Promise.resolve({ kind: 'ok', confirmed: 0, refused: 0, unresolved: 0 }),
    list: () =>
      (LIST[state] ?? (() => Promise.resolve({ kind: 'ok', returns: journalFor(state) })))(),
    payout: () => (PAYOUT[state] ?? never)(),
    reprintSlip: () => (REPRINT[state] ?? (() => Promise.resolve({ kind: 'printed' })))(),
  };
}

export function ReturnsProof(): JSX.Element {
  const state = readReturnsProofState();
  const params = { ...readOneFrameProofParams(), role: 'manager' as const, path: '/app/returns' };
  installWindowApi({ ...params, returns: 'off' });
  if (state !== 'Disabled') {
    (window as unknown as { api: Record<string, unknown> }).api.returns = returnsProofBridge(state);
  }
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    productSearch: true,
    returns: state !== 'Disabled',
  });
  if (useOperatorSessionStore.getState().state.kind === 'signedOut') {
    useOperatorSessionStore.getState().hydrateSignedIn({
      id: 'proof-manager',
      operator_id: 'op-manager',
      display_name: 'سارة عبد الحميد',
      role: 'manager',
      tenant_id: '7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77',
      branch_id: 'b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13',
      started_at: '2026-10-17T07:00:00Z',
    });
  }
  return (
    <AppRouter
      pairing={pairingBridge}
      operator={operatorBridge(params)}
      initialEntry={params.path}
    />
  );
}
