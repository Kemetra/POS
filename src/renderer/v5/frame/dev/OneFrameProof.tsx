import type { JSX } from 'react';

import type {
  ListStuckShiftsResponse,
  OperatorBridgeAPI,
  PairingBridgeAPI,
} from '../../../../shared/bridge-api';
import type { PairingStatus } from '../../../../shared/pairing-types';
import type { Role } from '../../../../shared/operator/role';
import type { BannerState } from '../../../../shared/sales/types';
import { AppRouter } from '../../../router';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';

/**
 * RT-498 (VN-S10 S10-1) — DEV-ONLY one-frame harness (`#/dev/one-frame-proof`),
 * the same contract as the RT-243 / RT-244 / RT-424 / RT-441 harnesses: the
 * REAL AppRouter at any `/app` path, against in-memory bridges, so every
 * former AppShell route can be captured inside the v5 frame at 1024 and 1280
 * without a backend. It proves layout and presentation only; the packaged
 * bench (S10-V, RT-505) remains the acceptance evidence.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `path` = any `/app/...` route (default
 * `/app/dashboard`); `role` = manager | admin | cashier (default manager);
 * `banner` = none | printer (a printer failure for the D-10-6 notice; default
 * none); `shifts` = some | none (what `listStuckShifts` answers; default some).
 */

export interface OneFrameProofParams {
  path: string;
  role: Role;
  banner: 'none' | 'printer';
  shifts: 'some' | 'none';
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback;
}

export function readOneFrameProofParams(): OneFrameProofParams {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const rawPath = params.get('path') ?? '';
  return {
    path: rawPath.startsWith('/app') ? rawPath : '/app/dashboard',
    role: oneOf<Role>(params.get('role'), ['manager', 'admin', 'cashier'], 'manager'),
    banner: oneOf(params.get('banner'), ['none', 'printer'], 'none'),
    shifts: oneOf(params.get('shifts'), ['some', 'none'], 'some'),
  };
}

const PAIRED: Extract<PairingStatus, { kind: 'paired' }> = {
  kind: 'paired',
  tenant_id: '7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77',
  branch_id: 'b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13',
  terminal_id: '0556bfa4-2c7e-4d19-b3a8-91f0e6d2c450',
  terminal_label: 'POS-03',
  paired_at: 1_735_689_600,
};

function stuckShifts(shifts: OneFrameProofParams['shifts']): ListStuckShiftsResponse {
  if (shifts === 'none') return { kind: 'stuck_shifts', shifts: [] };
  return {
    kind: 'stuck_shifts',
    shifts: [
      {
        shift_id: 'shift-1',
        cashier_display_name: 'أحمد سمير',
        terminal_label: 'POS-01',
        opened_at: '2026-10-15T06:00:00Z',
        duration_minutes: 190,
      },
      {
        shift_id: 'shift-2',
        cashier_display_name: 'ياسمين خالد',
        terminal_label: 'POS-03',
        opened_at: '2026-10-15T08:05:00Z',
        duration_minutes: 65,
      },
    ],
  };
}

function refused<T>(): () => Promise<T> {
  return () => Promise.resolve({ kind: 'refused', category: 'invalid_input' } as T);
}

export function operatorBridge(params: OneFrameProofParams): OperatorBridgeAPI {
  return {
    signIn: refused(),
    signOut: () => Promise.resolve({ kind: 'signed_out' as const }),
    getCurrentSession: () => Promise.resolve(null),
    _reportActivity: () => undefined,
    emitAuditEvent: refused(),
    _emitAuditEventSmoke: refused(),
    listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [] }),
    confirmTakeover: refused(),
    cancelTakeover: () => Promise.resolve({ kind: 'cancelled' as const }),
    resetCashierPin: refused(),
    provisionCashierPin: refused(),
    unlockCashier: refused(),
    forceCloseShift: refused(),
    listStuckShifts: () => Promise.resolve(stuckShifts(params.shifts)),
    dismissShiftClosedNotice: () => Promise.resolve(),
  } as unknown as OperatorBridgeAPI;
}

export const pairingBridge: PairingBridgeAPI = {
  getStatus: () => Promise.resolve(PAIRED),
  submit: () => Promise.reject(new Error('not used in the harness')),
};

function bannerState(banner: OneFrameProofParams['banner']): BannerState {
  return {
    printer_failure:
      banner === 'printer'
        ? { sale_id: 'sale-1', failure_reason: 'printer_offline', has_successful_print: false }
        : null,
    drawer_failure: null,
  };
}

/** The read-only bridges the moved screens touch on mount, in memory. */
export function installWindowApi(params: OneFrameProofParams): void {
  (window as unknown as { api?: unknown }).api = {
    pairing: pairingBridge,
    catalogue: {
      counts: () => Promise.resolve({ kind: 'ok', products: 12_480, barcodes: 15_902 }),
      freshness: () =>
        Promise.resolve({ kind: 'ok', last_success_at: '2026-10-15T09:42:00Z', is_empty: false }),
      refresh: () => Promise.resolve({ kind: 'started' }),
      search: () => Promise.resolve({ kind: 'not_found' }),
    },
    sales: {
      read: () => Promise.resolve({ kind: 'not_found' }),
      findByNumber: () => Promise.resolve({ kind: 'not_found' }),
      subscribe: () =>
        Promise.resolve({
          kind: 'ok',
          subscription_token: 'proof',
          banner_state: bannerState(params.banner),
        }),
      unsubscribe: () => Promise.resolve({ kind: 'ok' }),
    },
  };
}

export function OneFrameProof(): JSX.Element {
  const params = readOneFrameProofParams();
  installWindowApi(params);
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `proof-${params.role}`,
    operator_id: `op-${params.role}`,
    display_name: 'سارة عبد الحميد',
    role: params.role,
    tenant_id: PAIRED.tenant_id,
    branch_id: PAIRED.branch_id,
    started_at: '2026-10-15T07:00:00Z',
  });
  return (
    <AppRouter
      pairing={pairingBridge}
      operator={operatorBridge(params)}
      initialEntry={params.path}
    />
  );
}
