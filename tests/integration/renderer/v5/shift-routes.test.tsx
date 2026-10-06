/**
 * RT-17 slice 4 part 3 — the shift screens through the REAL AppRouter: both
 * render inside the v5 frame, the manager screen is guarded to manager/admin,
 * and with the flag off neither renders (and nothing calls the bridge).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../../../../src/renderer/router.js';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../../../src/shared/bridge-api.js';
import type { Role } from '../../../../src/shared/operator/role.js';
import { useFeatureFlagsStore } from '../../../../src/renderer/stores/feature-flags-store.js';
import { useOperatorSessionStore } from '../../../../src/renderer/stores/operator-session-store.js';
import { fakeShiftBridge } from '../../../../src/renderer/v5/__tests__/__helpers__/shift-test-kit.js';

function pairedBridge(): PairingBridgeAPI {
  return {
    getStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'paired' as const,
        tenant_id: 't1',
        branch_id: 'b1',
        terminal_id: 'term-1',
        terminal_label: 'Counter 1',
        paired_at: 1_735_689_600,
      }),
    ),
    submit: vi.fn(() => Promise.reject(new Error('not used'))),
  };
}

let bridge: ReturnType<typeof fakeShiftBridge>;

beforeEach(() => {
  bridge = fakeShiftBridge();
  (window as unknown as { api?: unknown }).api = { shiftCashup: bridge };
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

function signIn(role: Role, shiftCashup: boolean): void {
  useFeatureFlagsStore.getState().hydrate({ shiftCashup });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `sess-${role}`,
    operator_id: `op-${role}`,
    display_name: 'أمل',
    role,
    tenant_id: 't1',
    branch_id: 'b1',
    started_at: '2026-10-06T07:00:00.000Z',
  });
}

function renderAt(path: string): void {
  render(
    <AppRouter
      pairing={pairedBridge()}
      operator={{} as OperatorBridgeAPI}
      initialEntry={path}
    />,
  );
}

describe('/app/shift and /app/shift/manager through the AppRouter', () => {
  it('renders the cashier shift screen inside the v5 frame with the flag on', async () => {
    signIn('cashier', true);
    renderAt('/app/shift');
    const frame = await screen.findByTestId('v5-frame');
    expect(
      await within(frame).findByRole('heading', { level: 1, name: 'الوردية' }),
    ).toBeInTheDocument();
  });

  it('renders the manager screen inside the v5 frame for a manager', async () => {
    signIn('manager', true);
    renderAt('/app/shift/manager');
    const frame = await screen.findByTestId('v5-frame');
    expect(
      await within(frame).findByRole('heading', { level: 1, name: 'حالة الوردية' }),
    ).toBeInTheDocument();
  });

  it('guards the manager screen from a cashier', async () => {
    signIn('cashier', true);
    renderAt('/app/shift/manager');
    await waitFor(() => {
      expect(window.location.pathname).toBe('/sign-in');
    });
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it.each(['/app/shift', '/app/shift/manager'])(
    'never renders %s with the flag off, and calls nothing',
    async (path) => {
      signIn('manager', false);
      renderAt(path);
      await waitFor(() => {
        expect(window.location.pathname).not.toMatch(/^\/app\/shift/);
      });
      expect(screen.queryByRole('heading', { name: /الوردية/ })).not.toBeInTheDocument();
      expect(bridge.status).not.toHaveBeenCalled();
    },
  );

  it('shows the cashier the shift gate banner on the Sale screen (selling not blocked)', async () => {
    signIn('cashier', true);
    renderAt('/app/cart');
    const frame = await screen.findByTestId('v5-frame');
    expect(await within(frame).findByTestId('shift-gate-banner')).toBeInTheDocument();
    expect(within(frame).getByRole('region', { name: 'مساحة البيع' })).toBeInTheDocument();
  });
});
