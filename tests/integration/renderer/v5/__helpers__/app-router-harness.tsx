/**
 * Shared harness for driving the REAL AppRouter in v5 integration tests: a
 * paired terminal, an operator bridge with benign answers, a signed-in role,
 * and a `window.api` with the read-only bridges the manager screens touch on
 * mount (catalogue diagnostics reads pairing + catalogue).
 */
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';

import { AppRouter } from '../../../../../src/renderer/router.js';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../../../../src/shared/bridge-api.js';
import type { PairingStatus } from '../../../../../src/shared/pairing-types.js';
import type { Role } from '../../../../../src/shared/operator/role.js';
import { useFeatureFlagsStore } from '../../../../../src/renderer/stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../../../src/renderer/stores/operator-session-store.js';

export const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: 't1',
  branch_id: 'b1',
  terminal_id: 'term-1',
  terminal_label: 'POS-03',
  paired_at: 1_735_689_600,
};

export function pairedBridge(): PairingBridgeAPI {
  return {
    getStatus: vi.fn(() => Promise.resolve(PAIRED)),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

function refused<T>(): () => Promise<T> {
  return () => Promise.resolve({ kind: 'refused', category: 'invalid_input' } as T);
}

export function operatorBridge(): OperatorBridgeAPI {
  return {
    signIn: vi.fn(refused()),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    getCurrentSession: vi.fn(() => Promise.resolve(null)),
    _reportActivity: vi.fn(),
    emitAuditEvent: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    _emitAuditEventSmoke: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    listBranchRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
    confirmTakeover: vi.fn(refused()),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
    resetCashierPin: vi.fn(refused()),
    provisionCashierPin: vi.fn(refused()),
    unlockCashier: vi.fn(refused()),
    forceCloseShift: vi.fn(refused()),
    listStuckShifts: vi.fn(() => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] })),
    dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
  } as OperatorBridgeAPI;
}

/** The read-only bridges the manager screens call on mount. */
export function installManagerScreenApi(): void {
  (window as unknown as { api?: unknown }).api = {
    pairing: { getStatus: vi.fn(() => Promise.resolve(PAIRED)) },
    catalogue: {
      counts: vi.fn(() => Promise.resolve({ kind: 'ok', products: 0, barcodes: 0 })),
      freshness: vi.fn(() =>
        Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
      ),
      refresh: vi.fn(() => Promise.resolve({ kind: 'started' })),
      search: vi.fn(() => Promise.resolve({ kind: 'not_found' })),
    },
  };
}

export function signInAs(role: Role): void {
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `sess-${role}`,
    operator_id: `op-${role}`,
    display_name: 'سارة عبد الحميد',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-15T07:00:00.000Z',
  });
}

export function resetAppStores(): void {
  useOperatorSessionStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
}

export function renderAppAt(path: string): RenderResult {
  return render(
    <AppRouter pairing={pairedBridge()} operator={operatorBridge()} initialEntry={path} />,
  );
}
