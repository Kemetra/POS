/**
 * RT-530 — the route element and the frame notice: nothing renders and nothing
 * is called with the flag off, no session or no bridge; with it on, the way to
 * the void screen, and a persistent banner while a refused void is unseen.
 */
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { SaleVoidNotice } from '../SaleVoidNotice';
import { VOID_COPY } from '../void-copy';
import { VoidRoute } from '../VoidRoute';
import { fakeBridges, fakeSaleVoidBridge, journalView } from './__helpers__/void-fixtures';

beforeEach(() => {
  useFeatureFlagsStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
});

function Where(): JSX.Element {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function at(path: string, element: JSX.Element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {element}
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function signIn(role: 'cashier' | 'manager' | 'admin' = 'manager'): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `session-${role}`,
    operator_id: `op-${role}`,
    display_name: 'منى',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-06-07T08:00:00Z',
  });
}

const enable = (): void => {
  useFeatureFlagsStore.getState().hydrate({ saleVoid: true });
};

describe('VoidRoute', () => {
  it('leaves for /app with the flag off and calls nothing', async () => {
    signIn();
    const bridges = fakeBridges();
    at('/app/void', <VoidRoute bridges={bridges} refreshMs={0} />);
    await waitFor(() => {
      expect(screen.getByTestId('where')).toHaveTextContent(/^\/app$/);
    });
    expect(bridges.saleVoid.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: VOID_COPY.title })).not.toBeInTheDocument();
  });

  it('leaves for /app when the preload has no void bridge', () => {
    signIn();
    enable();
    at('/app/void', <VoidRoute bridges={null} refreshMs={0} />);
    expect(screen.queryByRole('heading', { name: VOID_COPY.title })).not.toBeInTheDocument();
  });

  it('renders nothing without a session', () => {
    enable();
    const bridges = fakeBridges();
    at('/app/void', <VoidRoute bridges={bridges} refreshMs={0} />);
    expect(screen.queryByRole('heading', { name: VOID_COPY.title })).not.toBeInTheDocument();
    expect(bridges.saleVoid.list).not.toHaveBeenCalled();
  });

  it.each(['cashier', 'manager', 'admin'] as const)(
    'shows the screen to a %s with the flag on',
    async (role) => {
      signIn(role);
      enable();
      const bridges = fakeBridges();
      at('/app/void', <VoidRoute bridges={bridges} refreshMs={0} />);
      expect(await screen.findByRole('heading', { name: VOID_COPY.title })).toBeInTheDocument();
      expect(bridges.saleVoid.list).toHaveBeenCalledTimes(1);
    },
  );
});

describe('SaleVoidNotice', () => {
  it('renders nothing and calls nothing with the flag off', () => {
    signIn();
    const bridge = fakeSaleVoidBridge();
    at('/app/cart', <SaleVoidNotice bridge={bridge} refreshMs={0} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(bridge.list).not.toHaveBeenCalled();
  });

  it('renders nothing without a session or a bridge', () => {
    enable();
    const bridge = fakeSaleVoidBridge();
    at('/app/cart', <SaleVoidNotice bridge={bridge} refreshMs={0} />);
    expect(bridge.list).not.toHaveBeenCalled();
    cleanup();
    signIn();
    at('/app/cart', <SaleVoidNotice bridge={null} refreshMs={0} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('offers the way to the void screen, and no banner when nothing needs attention', async () => {
    signIn('cashier');
    enable();
    const bridge = fakeSaleVoidBridge([journalView({ state: 'confirmed' })]);
    at('/app/cart', <SaleVoidNotice bridge={bridge} refreshMs={0} />);
    const link = await screen.findByRole('link', { name: VOID_COPY.link });
    expect(link).toHaveAttribute('href', '/app/void');
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('void-attention-banner')).not.toBeInTheDocument();
  });

  it('shows a persistent banner while a refused void is unseen, with the way to it', async () => {
    signIn();
    enable();
    const bridge = fakeSaleVoidBridge([
      journalView({
        state: 'refused',
        refusal_reason: 'void_outside_business_day',
        needs_attention: true,
      }),
    ]);
    at('/app/cart', <SaleVoidNotice bridge={bridge} refreshMs={0} />);
    const banner = await screen.findByTestId('void-attention-banner');
    expect(banner).toHaveTextContent(VOID_COPY.attentionBanner);
    expect(screen.getByRole('link', { name: VOID_COPY.attentionAction })).toHaveAttribute(
      'href',
      '/app/void',
    );
  });

  it('has no banner after the refusal is acknowledged, and none on the void screen itself', async () => {
    signIn();
    enable();
    const seen = fakeSaleVoidBridge([
      journalView({ state: 'refused', refusal_reason: 'conflict', needs_attention: false }),
    ]);
    at('/app/cart', <SaleVoidNotice bridge={seen} refreshMs={0} />);
    await waitFor(() => {
      expect(seen.list).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('void-attention-banner')).not.toBeInTheDocument();
    cleanup();

    const unseen = fakeSaleVoidBridge([
      journalView({ state: 'refused', refusal_reason: 'conflict', needs_attention: true }),
    ]);
    at('/app/void', <SaleVoidNotice bridge={unseen} refreshMs={0} />);
    await waitFor(() => {
      expect(unseen.list).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('void-attention-banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: VOID_COPY.link })).not.toBeInTheDocument();
  });

  it('shows no banner when the list cannot be read', async () => {
    signIn();
    enable();
    const bridge = fakeSaleVoidBridge();
    bridge.list.mockRejectedValue(new Error('ipc down'));
    at('/app/cart', <SaleVoidNotice bridge={bridge} refreshMs={0} />);
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('void-attention-banner')).not.toBeInTheDocument();
  });
});
