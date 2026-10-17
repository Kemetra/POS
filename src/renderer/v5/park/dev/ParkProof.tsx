import type { JSX } from 'react';

import type { CartBridgeAPI } from '../../../../shared/bridge-api';
import { CartState } from '../../../../shared/cart/cart-state';
import type {
  CartParkBridgeAPI,
  CartParkResponse,
  CartPreviewResumeResponse,
  CartResumeResponse,
  ParkedSaleView,
} from '../../../../shared/cart/park-types';
import type { ShiftCashupBridgeAPI } from '../../../../shared/shift-cashup/types';
import { AppRouter } from '../../../router';
import { ScanGuardHost } from '../../../scan/ScanGuardHost';
import { useCartStore } from '../../../stores/cart-store';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import {
  installWindowApi,
  operatorBridge,
  pairingBridge,
  readOneFrameProofParams,
} from '../../frame/dev/OneFrameProof';

/**
 * RT-445 — DEV-ONLY park / resume harness (`#/dev/park-proof`), the same
 * contract as the RT-243 / RT-424 / RT-498 harnesses: the REAL AppRouter (the
 * live Sale, the parked list, the review, the shift close) against in-memory
 * bridges, so every PK-3 state can be captured at 1024 and 1280 without a
 * backend. It proves layout and presentation only; the packaged bench (PK-V,
 * RT-446) remains the acceptance evidence.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `state` = one of the 21 PK-3 reference names
 * (default SaleReady). Interactive states (the dialog, the review) are
 * reached by the capture script pressing the same visible buttons a cashier
 * presses.
 */

export const PARK_PROOF_STATES = [
  'SaleReady',
  'SaleEmpty',
  'ParkDialog',
  'ParkLabel',
  'ParkInvalid',
  'ParkSaving',
  'ParkLimit',
  'Parked',
  'ListEmpty',
  'ListOne',
  'ListFive',
  'ListStale',
  'ReviewPrice',
  'ReviewRemoved',
  'ReviewMixed',
  'ConflictClean',
  'ConflictChanges',
  'RefCatalogue',
  'RefChanged',
  'RefCheckout',
  'ShiftClose',
] as const;
export type ParkProofState = (typeof PARK_PROOF_STATES)[number];

export function readParkProofState(): ParkProofState {
  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('state');
  return PARK_PROOF_STATES.find((s) => s === raw) ?? 'SaleReady';
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A parked time `ago` ms before now, so «اليوم» and «قديم» read as drawn on any day. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** [cart id, label, line count, total minor, parked ms ago, stale?] */
type SaleRow = readonly [string, string | null, number, number, number, boolean?];

function sale([id, label, lines, total, at, stale = false]: SaleRow): ParkedSaleView {
  return { cart_id: id, label, line_count: lines, total_minor: total, parked_at: ago(at), stale };
}

const FIVE: ParkedSaleView[] = [
  sale(['p1', null, 1, 4500, 5 * MIN]),
  sale(['p2', 'ينتظر الروشتة', 4, 21200, 19 * MIN]),
  sale(['p3', 'طلب التوصيل', 5, 64025, 110 * MIN]),
  sale(['p4', 'عميل الصف الثاني', 2, 11850, 148 * MIN]),
  sale(['p5', 'ينتظر وصول الروشتة الأصلية من المريض', 4, 9600, 235 * MIN]),
];

const STALE: ParkedSaleView[] = [
  sale(['p2', 'ينتظر الروشتة', 4, 21200, 19 * MIN]),
  sale(['p3', 'طلب التوصيل', 5, 64025, DAY + 3 * 60 * MIN, true]),
  sale(['p4', 'عميل الصف الثاني', 2, 11850, DAY + 10 * 60 * MIN, true]),
];

const REVIEW_STATES = ['Review', 'Conflict', 'Ref'] as const;

/** The states reached from the list's «استئناف البيع». */
function opensReview(state: ParkProofState): boolean {
  return REVIEW_STATES.some((prefix) => state.startsWith(prefix));
}

function listFor(state: ParkProofState): ParkedSaleView[] {
  if (state === 'ListEmpty') return [];
  if (state === 'ListOne') return [FIVE[1] as ParkedSaleView];
  if (state === 'ListStale') return STALE;
  if (state.startsWith('List')) return FIVE;
  // The review states open «ينتظر الروشتة» from a one-row list.
  if (opensReview(state)) return [FIVE[1] as ParkedSaleView];
  return FIVE.slice(0, state === 'ParkLimit' ? 4 : 2);
}

const CHANGES = [
  {
    line_id: 'l3',
    display_name: 'فولتارين جل 1% — 50 جم',
    quantity: 1,
    old_unit_minor: 6800,
    new_unit_minor: 6400,
  },
  {
    line_id: 'l1',
    display_name: 'بنادول إكسترا 500 مجم — 24 قرص',
    quantity: 2,
    old_unit_minor: 4500,
    new_unit_minor: 4800,
  },
];
const REMOVED = [
  { line_id: 'l4', display_name: 'كونجستال أقراص', quantity: 1 },
  { line_id: 'l5', display_name: 'نوفالجين أقراص 500 مجم', quantity: 1 },
];

function previewFor(state: ParkProofState): CartPreviewResumeResponse {
  if (state === 'RefCatalogue') return { kind: 'refused', reason: 'catalogue_unavailable' };
  const price = ['ReviewPrice', 'ReviewMixed', 'ConflictChanges', 'RefChanged'].includes(state);
  const removed = ['ReviewRemoved', 'ReviewMixed', 'ConflictChanges'].includes(state);
  return {
    kind: 'preview',
    changes: price ? CHANGES : [],
    unavailable: removed ? REMOVED : [],
    diff_token: 'proof-diff',
  };
}

/** RefChanged answers its first resume with `price_changes_unaccepted` (OD-14). */
function resumeFor(state: ParkProofState): () => CartResumeResponse {
  let calls = 0;
  return () => {
    calls += 1;
    if (state === 'RefChanged' && calls === 1)
      return { kind: 'refused', reason: 'price_changes_unaccepted' };
    if (state === 'RefCheckout') return { kind: 'refused', reason: 'checkout_in_progress' };
    return { kind: 'resumed', cart_id: 'p2' };
  };
}

function parkFor(state: ParkProofState): () => Promise<CartParkResponse> {
  if (state === 'ParkSaving') return () => new Promise<CartParkResponse>(() => undefined);
  if (state === 'ParkInvalid')
    return () => Promise.resolve({ kind: 'refused', reason: 'invalid_label' });
  if (state === 'ParkLimit')
    return () => Promise.resolve({ kind: 'refused', reason: 'park_limit_reached' });
  return () => Promise.resolve({ kind: 'parked' });
}

const SALE_LINES = [
  ['l1', 'بنادول إكسترا 500 مجم — 24 قرص', 2, 4500],
  ['l2', 'أموكسيسيلين/كلافولانيت 875/125 مجم', 1, 18750],
  ['l3', 'فولتارين جل 1% — 50 جم', 1, 6800],
  ['l4', 'كونجستال أقراص', 1, 2950],
] as const;

/** What the session's current cart is: the drawn four-line sale, two lines (conflict), frozen, or none. */
function currentFor(state: ParkProofState): { lines: number; state: CartState } | null {
  if (state === 'SaleEmpty' || state.startsWith('List')) return null;
  if (state.startsWith('Conflict')) return { lines: 2, state: CartState.editing };
  if (state === 'RefCheckout') return { lines: 4, state: CartState.frozen_handed_off };
  // Conflict and RefCheckout returned above; the other review states have no current sale.
  if (opensReview(state)) return null;
  return { lines: 4, state: CartState.editing };
}

function snapshotLines(count: number): unknown[] {
  // The conflict's current sale: two lines worth 95.00 EGP, as drawn.
  const rows =
    count === 2
      ? [
          ['c1', 'بنادول إكسترا 500 مجم — 24 قرص', 1, 4500],
          ['c2', 'فيتامين سي 1000 مجم', 1, 5000],
        ]
      : SALE_LINES;
  return rows.map(([line_id, display_name, quantity, unit]) => ({
    line_id,
    display_name,
    quantity,
    unit_price_minor: unit,
    line_subtotal_minor: Number(unit) * Number(quantity),
    note: null,
    version: 1,
  }));
}

function cartBridge(state: ParkProofState): CartBridgeAPI {
  const current = currentFor(state);
  const resume = resumeFor(state);
  let items = listFor(state);
  const parked: CartParkBridgeAPI = {
    park: (req) =>
      parkFor(state)().then((answer) => {
        if (answer.kind === 'parked')
          items = [sale(['new', req.label ?? null, 4, 37500, 0]), ...items];
        return answer;
      }),
    listParked: () => Promise.resolve({ kind: 'parked_sales', items }),
    previewResume: () => Promise.resolve(previewFor(state)),
    resume: () => Promise.resolve(resume()),
  };
  const refused = (): Promise<unknown> => Promise.resolve({ kind: 'refused', reason: 'invalid' });
  return {
    create: () => Promise.resolve({ kind: 'ok', cart_id: 'proof-new' }),
    lines: { add: refused, update: refused, remove: refused, setNote: refused },
    discountPlaceholders: { add: refused, remove: refused },
    void: refused,
    handoff: refused,
    subscribe: refused,
    snapshot: ({ cart_id }: { cart_id: string }) =>
      Promise.resolve({
        kind: 'ok',
        snapshot: {
          cart_id,
          state: current?.state ?? CartState.editing,
          lines: snapshotLines(current?.lines ?? 4),
          discount_placeholders: [],
          paid: false,
          envelope: null,
        },
      }),
    parked,
  } as unknown as CartBridgeAPI;
}

function shiftBridge(): ShiftCashupBridgeAPI {
  const status = {
    openShift: {
      shiftId: 'shift-proof',
      openedAt: ago(5 * 60 * MIN),
      currencyCode: 'EGP',
      openingFloatMinor: 50_000,
      payInTotalMinor: 0,
      payOutTotalMinor: 0,
    },
    queue: { pending: 0, waiting: 0, blocked: 0, envelopePending: 0 },
    stranded: { unsyncedFacts: 0, openShifts: 0 },
    pendingDrawerActivity: { refundPayouts: 0, unfinalizedSales: 0 },
    probeRefusals: { payOut: 0, varianceClose: 0, approverFailure: 0 },
  };
  return {
    status: () => Promise.resolve({ kind: 'status', status }),
    close: () =>
      Promise.resolve({ kind: 'refused', reason: 'parked_sales_present', parkedCount: 3 }),
  } as unknown as ShiftCashupBridgeAPI;
}

function pathFor(state: ParkProofState): string {
  if (state === 'ShiftClose') return '/app/shift';
  if (state.startsWith('List') || opensReview(state)) return '/app/cart/parked';
  return '/app/cart';
}

export function ParkProof(): JSX.Element {
  const state = readParkProofState();
  const params = readOneFrameProofParams();
  installWindowApi({ ...params, role: 'cashier' });
  const api = (window as unknown as { api: Record<string, unknown> }).api;
  api.cart = cartBridge(state);
  api.shiftCashup = shiftBridge();
  // The catalogue was refreshed 40 minutes ago: «آخر كتالوج: اليوم …».
  api.catalogue = {
    ...(api.catalogue as object),
    freshness: () =>
      Promise.resolve({ kind: 'ok', last_success_at: ago(40 * MIN), is_empty: false }),
  };
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    productSearch: true,
    shiftCashup: true,
  });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'proof-cashier',
    operator_id: 'op-cashier',
    display_name: 'منى عادل',
    role: 'cashier',
    tenant_id: '7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77',
    branch_id: 'b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13',
    started_at: ago(5 * 60 * MIN),
  });
  if (currentFor(state) !== null && useCartStore.getState().activeCart === null)
    useCartStore.getState().applyCartCreated('proof-current');
  // The scan guard is mounted by App in production; the harness mounts it too, for the scanner walk.
  return (
    <>
      <ScanGuardHost />
      <AppRouter
        pairing={pairingBridge}
        operator={operatorBridge(params)}
        initialEntry={pathFor(state)}
      />
    </>
  );
}
