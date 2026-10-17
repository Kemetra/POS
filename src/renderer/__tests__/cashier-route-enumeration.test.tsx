import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../router';
import { useOperatorSessionStore } from '../stores/operator-session-store';
import type { PairingBridgeAPI } from '../../shared/bridge-api';
import type { Role } from '../../shared/operator/role';
import { installViewport } from '../v5/__tests__/__helpers__/viewport-bands';

/**
 * RT-597 (RT-505 O1, owner decision on OD-6) — `/app/inventory`,
 * `/app/inventory/diagnostics` and `/app/settings` admit manager and admin only.
 * A signed-in cashier who types one of those URLs leaves the screen, like on the
 * other manager surfaces. Secondary UX defence: main gates the calls by role.
 *
 * The three screens are stubbed so the test asserts the ROUTE decision, not the
 * screen content.
 */
vi.mock('../routes/app/InventoryPlaceholder', () => ({
  InventoryPlaceholder: () => <div data-testid="screen-inventory" />,
}));
vi.mock('../routes/app/CatalogueDiagnostics', () => ({
  CatalogueDiagnostics: () => <div data-testid="screen-diagnostics" />,
}));
vi.mock('../routes/app/SettingsHelpPlaceholder', () => ({
  SettingsHelpPlaceholder: () => <div data-testid="screen-settings" />,
}));

const getStatus = vi.fn().mockResolvedValue({
  kind: 'paired',
  tenant_id: 'tenant-001',
  branch_id: 'branch-001',
  terminal_id: 'term-001',
  terminal_label: 'POS-001',
  paired_at: 1_735_689_600,
});
vi.mock('../routes/app/SalesWorkspace', () => ({
  SalesWorkspace: () => <div data-testid="screen-sales" />,
}));
// Without an operator bridge a guard miss falls through /sign-in to the start
// path, so this stub is where a turned-away operator lands.
vi.mock('../routes/paired/PairedScreen', () => ({
  PairedScreen: () => <div data-testid="screen-redirected" />,
}));

const pairing: PairingBridgeAPI = { getStatus, submit: vi.fn() };

function signInAs(role: Role): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'مستخدم',
        role,
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-10-17T08:00:00.000Z',
      },
    },
  });
}

const GUARDED: ReadonlyArray<readonly [string, string]> = [
  ['/app/inventory', 'screen-inventory'],
  ['/app/inventory/diagnostics', 'screen-diagnostics'],
  ['/app/settings', 'screen-settings'],
];

beforeEach(() => {
  installViewport(1280);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
});

describe('RT-597 — cashier route enumeration', () => {
  it.each(GUARDED)('redirects a cashier away from %s', async (path, testId) => {
    signInAs('cashier');
    render(<AppRouter pairing={pairing} initialEntry={path} />);
    expect(await screen.findByTestId('screen-redirected')).toBeInTheDocument();
    expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
  });

  it.each(GUARDED)('still renders %s for a manager', async (path, testId) => {
    signInAs('manager');
    render(<AppRouter pairing={pairing} initialEntry={path} />);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it.each(GUARDED)('still renders %s for an admin', async (path, testId) => {
    signInAs('admin');
    render(<AppRouter pairing={pairing} initialEntry={path} />);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it('keeps /app/sales reachable for a cashier (RT-546)', async () => {
    signInAs('cashier');
    render(<AppRouter pairing={pairing} initialEntry="/app/sales" />);
    expect(await screen.findByTestId('screen-sales')).toBeInTheDocument();
    expect(screen.queryByTestId('screen-redirected')).not.toBeInTheDocument();
  });
});
