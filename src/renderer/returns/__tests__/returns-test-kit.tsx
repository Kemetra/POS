import { act, render, screen, type RenderResult } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { vi, type Mock } from 'vitest';

import type {
  ReturnJournalView,
  ReturnQuoteView,
  ReturnableSaleView,
  ReturnsBridgeAPI,
  ReturnsListResponse,
  ReturnsLookupResponse,
  ReturnsQuoteResponse,
  ReturnsResolveResponse,
  ReturnsSubmitResponse,
} from '../../../shared/returns/types.js';
import type { Role } from '../../../shared/operator/role.js';
import type { SessionStateEvent } from '../../../shared/bridge-api.js';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store.js';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../stores/operator-session-store.js';
import { ReturnsRoute } from '../ReturnsRoute.js';

/** RT-15 S3 test kit: S2-shaped fixtures, a scripted bridge, a render helper. */

export const L1 = '0190a000-0000-7000-8000-000000000001';
export const L2 = '0190a000-0000-7000-8000-000000000002';
export const L3 = '0190a000-0000-7000-8000-000000000003';
export const SALE_REF = '0190a000-0000-7000-8000-0000000000aa';
export const RETURN_REF = '0190a000-0000-7000-8000-0000000000bb';
export const SALE_NUMBER = 'T1-000042';

export const SALE: ReturnableSaleView = {
  saleId: 'sale-1',
  saleNumber: SALE_NUMBER,
  saleRef: SALE_REF,
  currencyCode: 'EGP',
  lines: [
    line(L1, 'بانادول 500 مجم', [3, 1, 2], 2500),
    line(L2, 'فيتامين سي', [1, 1, 0], 1000),
    line(L3, 'شاش طبي', [5, 0, 5], 1250),
  ],
};

function line(lineRef: string, lineName: string, q: readonly number[], unitPriceMinor: number) {
  const [soldQuantity = 0, returnedQuantity = 0, returnableQuantity = 0] = q;
  return { lineRef, lineName, soldQuantity, returnedQuantity, returnableQuantity, unitPriceMinor };
}

/** Deliberately NOT unit price × quantity (2500): the screen must show main's number. */
export const QUOTE: ReturnQuoteView = {
  saleRef: SALE_REF,
  currencyCode: 'EGP',
  lines: [{ lineRef: L1, quantity: 1, amountMinor: 2499 }],
  totalMinor: 2499,
};

export function journal(overrides: Partial<ReturnJournalView> = {}): ReturnJournalView {
  return {
    returnId: 'ret-1',
    saleId: 'sale-1',
    saleNumber: SALE_NUMBER,
    state: 'confirmed',
    currencyCode: 'EGP',
    quotedTotalMinor: 2499,
    returnTotalMinor: 2499,
    returnRef: RETURN_REF,
    refusalReason: null,
    createdAt: '2026-10-04T09:05:00.000Z',
    confirmedAt: '2026-10-04T09:05:02.000Z',
    lines: [{ lineRef: L1, quantity: 1 }],
    ...overrides,
  };
}

export interface FakeReturnsBridge extends ReturnsBridgeAPI {
  lookup: Mock<(req: unknown) => Promise<ReturnsLookupResponse>>;
  quote: Mock<(req: unknown) => Promise<ReturnsQuoteResponse>>;
  submit: Mock<(req: unknown) => Promise<ReturnsSubmitResponse>>;
  resolve: Mock<() => Promise<ReturnsResolveResponse>>;
  list: Mock<() => Promise<ReturnsListResponse>>;
}

export function fakeBridge(): FakeReturnsBridge {
  return {
    lookup: vi.fn(() => Promise.resolve({ kind: 'ok' as const, sale: SALE })),
    quote: vi.fn(() => Promise.resolve({ kind: 'ok' as const, quote: QUOTE })),
    submit: vi.fn(() =>
      Promise.resolve({ kind: 'confirmed' as const, ret: journal(), replayed: false }),
    ),
    resolve: vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, confirmed: 0, refused: 0, unresolved: 0 }),
    ),
    list: vi.fn(() => Promise.resolve({ kind: 'ok' as const, returns: [] })),
  };
}

export function session(role: Role, id = `sess-${role}`): OperatorSessionView {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: 'مدير الفرع',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-04T08:00:00.000Z',
  };
}

export function signIn(view: OperatorSessionView): void {
  useOperatorSessionStore.setState({ state: { kind: 'signedIn', session: view } });
}

/** Main's session-state push, as the operator bridge exposes it. */
export interface FakeSessionEvents {
  readonly onSessionStateChanged: (cb: (e: SessionStateEvent) => void) => () => void;
  /** Deliver one push inside act. */
  readonly push: (e: SessionStateEvent) => void;
}

export function fakeSessionEvents(): FakeSessionEvents {
  const listeners = new Set<(e: SessionStateEvent) => void>();
  return {
    onSessionStateChanged: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    push: (e) => {
      act(() => {
        for (const cb of listeners) cb(e);
      });
    },
  };
}

export interface RenderReturnsOptions {
  readonly bridge?: ReturnsBridgeAPI | null;
  readonly role?: Role;
  readonly flag?: boolean;
  readonly sessionEvents?: FakeSessionEvents;
}

export function renderReturns(options: RenderReturnsOptions = {}): RenderResult {
  useFeatureFlagsStore.getState().hydrate({ returns: options.flag ?? true });
  signIn(session(options.role ?? 'manager'));
  const bridge = options.bridge === undefined ? fakeBridge() : options.bridge;
  return render(<ReturnsRoute bridge={bridge} sessionEvents={options.sessionEvents ?? null} />);
}

export function resetStores(): void {
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
}

/** Type the sale number and press Enter; resolves once the line picker shows. */
export async function lookUpSale(user: UserEvent, saleNumber = SALE_NUMBER): Promise<void> {
  await user.type(screen.getByLabelText('رقم البيع'), `${saleNumber}{Enter}`);
  await screen.findByRole('heading', { name: 'اختر الأصناف المرتجعة' });
}

/** Pick one unit of the first line and ask main for the refund amount. */
export async function pickAndQuote(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
  await user.click(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' }));
  await screen.findByRole('heading', { name: 'ملخص الاسترداد' });
}

/** Look up, pick, quote and confirm: resolves after the confirm click. */
export async function submitReturn(user: UserEvent): Promise<void> {
  await lookUpSale(user);
  await pickAndQuote(user);
  await user.click(screen.getByRole('button', { name: 'تأكيد الإرجاع' }));
}

/** A promise the test settles by hand (for in-flight and stale-response cases). */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Settle a deferred bridge answer inside act, so React commits the result. */
export async function settle<T>(
  pending: { promise: Promise<T>; resolve: (v: T) => void },
  value: T,
): Promise<void> {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
  });
}
