import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../../../src/renderer/router.js';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../../src/shared/bridge-api.js';
import type { PairingStatus } from '../../../src/shared/pairing-types.js';
import {
  useOperatorSessionStore,
  type OperatorSessionView,
} from '../../../src/renderer/stores/operator-session-store.js';

/**
 * RT-424 — `/app/manager/cashiers` through the real AppRouter: a manager and
 * an admin reach the Cashiers screen INSIDE the v5 frame (UX-09); signed out,
 * the route never mounts it. (The cashier denial is covered by
 * cashier-route-enumeration.test.tsx, paths 7–12.)
 */

const STATUS: PairingStatus = {
  kind: 'paired',
  tenant_id: 't1',
  branch_id: 'b1',
  terminal_id: 'term-424',
  terminal_label: 'POS-03',
  paired_at: 1_735_689_600,
};

function pairedBridge(): PairingBridgeAPI {
  return {
    getStatus: vi.fn(() => Promise.resolve(STATUS)),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

const refused = () =>
  Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const });

function operatorBridge(list: OperatorBridgeAPI['listCashierPinStatus']): OperatorBridgeAPI {
  return {
    signIn: vi.fn(refused),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    getCurrentSession: vi.fn(() => Promise.resolve(null)),
    _reportActivity: vi.fn(),
    emitAuditEvent: vi.fn(refused),
    _emitAuditEventSmoke: vi.fn(refused),
    listBranchRoster: vi.fn(refused),
    confirmTakeover: vi.fn(refused),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
    resetCashierPin: vi.fn(refused),
    provisionCashierPin: vi.fn(refused),
    unlockCashier: vi.fn(refused),
    forceCloseShift: vi.fn(refused),
    listStuckShifts: vi.fn(refused),
    dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
    listCashierPinStatus: list,
  };
}

function session(role: OperatorSessionView['role']): OperatorSessionView {
  return {
    id: `sess-${role}`,
    operator_id: `op-${role}`,
    display_name: 'سارة',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-12T08:00:00.000Z',
  };
}

async function renderAt(
  role: OperatorSessionView['role'] | null,
): Promise<ReturnType<typeof vi.fn>> {
  if (role !== null) {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn(session(role));
  }
  const list = vi.fn(() =>
    Promise.resolve({
      kind: 'cashiers' as const,
      cashiers: [{ id: 'user_clerk_A', display_name: 'منى', pin: 'ready' as const }],
    }),
  );
  const operator = operatorBridge(list);
  render(
    <AppRouter pairing={pairedBridge()} operator={operator} initialEntry="/app/manager/cashiers" />,
  );
  await waitFor(() => {
    expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument();
  });
  return list;
}

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('RT-424 /app/manager/cashiers through AppRouter', () => {
  it.each(['manager', 'admin'] as const)(
    'a %s reaches the Cashiers screen inside the v5 frame',
    async (role) => {
      const list = await renderAt(role);
      const frame = await screen.findByTestId('v5-frame');
      const surface = await within(frame).findByTestId('cashier-management');
      expect(surface.closest('main')).not.toBeNull();
      expect(await within(surface).findAllByTestId('cashier-row')).toHaveLength(1);
      expect(list).toHaveBeenCalled();
    },
  );

  it('signed out, the screen never mounts and nothing is read', async () => {
    const list = await renderAt(null);
    await waitFor(() => {
      expect(screen.queryByTestId('cashier-management')).not.toBeInTheDocument();
    });
    expect(list).not.toHaveBeenCalled();
  });
});
