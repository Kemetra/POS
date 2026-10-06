/**
 * RT-17 slice 4 part 3 — shared fixtures for the v5 shift screen tests: a fake
 * `shiftCashup` bridge (every member a spy with a benign default answer), the
 * flag and session setup, and a router harness.
 */
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi, type Mock } from 'vitest';

import type { Role } from '../../../../shared/operator/role';
import type {
  ShiftCashupBridgeAPI,
  ShiftStatusView,
} from '../../../../shared/shift-cashup/types';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';

export type FakeShiftBridge = { [K in keyof ShiftCashupBridgeAPI]: Mock<ShiftCashupBridgeAPI[K]> };

export const OPENED_AT = '2026-10-06T08:00:00.000Z';

export function openShiftView(): NonNullable<ShiftStatusView['openShift']> {
  return {
    shiftId: '0192f5a2-3b4c-7d8e-9f01-000000000001',
    openedAt: OPENED_AT,
    currencyCode: 'EGP',
    openingFloatMinor: 50_000,
    payInTotalMinor: 2_500,
    payOutTotalMinor: 1_000,
  };
}

export function statusView(overrides: Partial<ShiftStatusView> = {}): ShiftStatusView {
  return {
    openShift: null,
    queue: { pending: 0, waiting: 0, blocked: 0, envelopePending: 0 },
    stranded: { unsyncedFacts: 0, openShifts: 0 },
    pendingDrawerActivity: { refundPayouts: 0, unfinalizedSales: 0 },
    probeRefusals: { payOut: 0, varianceClose: 0, approverFailure: 0 },
    ...overrides,
  };
}

export const MANAGERS = [
  { managerRef: '7f3c1e2a-0b4d-4c5e-8f60-0000000000aa', displayName: 'منى المديرة' },
  { managerRef: '7f3c1e2a-0b4d-4c5e-8f60-0000000000bb', displayName: 'كريم المدير' },
];

/** A bridge with no open shift, two enrolled managers and accepting answers. */
export function fakeShiftBridge(status: ShiftStatusView = statusView()): FakeShiftBridge {
  return {
    open: vi.fn<ShiftCashupBridgeAPI['open']>(() =>
      Promise.resolve({ kind: 'opened', shiftId: 'shift-1', openedAt: OPENED_AT }),
    ),
    payIn: vi.fn<ShiftCashupBridgeAPI['payIn']>(() =>
      Promise.resolve({ kind: 'recorded', movementId: 'm-1', shiftId: 'shift-1' }),
    ),
    payOut: vi.fn<ShiftCashupBridgeAPI['payOut']>(() =>
      Promise.resolve({ kind: 'recorded', movementId: 'm-2', shiftId: 'shift-1' }),
    ),
    close: vi.fn<ShiftCashupBridgeAPI['close']>(() =>
      Promise.resolve({ kind: 'closed', shiftId: 'shift-1', closedAt: OPENED_AT }),
    ),
    status: vi.fn<ShiftCashupBridgeAPI['status']>(() =>
      Promise.resolve({ kind: 'status', status }),
    ),
    enrollManagerPin: vi.fn<ShiftCashupBridgeAPI['enrollManagerPin']>(() =>
      Promise.resolve({ kind: 'enrolled' }),
    ),
    listEnrolledManagers: vi.fn<ShiftCashupBridgeAPI['listEnrolledManagers']>(() =>
      Promise.resolve({ kind: 'managers', managers: MANAGERS }),
    ),
  };
}

export function signIn(role: Role): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `session-${role}`,
    operator_id: `op-${role}`,
    display_name: 'د. سارة',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-06T07:00:00Z',
  });
}

export function enableShiftFlag(on = true): void {
  useFeatureFlagsStore.getState().hydrate({ cart: true, shiftCashup: on });
}

export function resetShiftStores(): void {
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
}

function WhereAmI(): ReactNode {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** Renders `element` at `path` with a location probe on every other path. */
export function renderAt(input: { path: string; pattern: string; element: ReactNode }): RenderResult {
  return render(
    <MemoryRouter initialEntries={[input.path]}>
      <Routes>
        <Route path={input.pattern} element={input.element} />
        <Route path="*" element={<WhereAmI />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Every amount the screens could format (`N.NN EGP`), anywhere in `text`. */
export const MONEY_TEXT = /\d+\.\d{2}\s*EGP/;
