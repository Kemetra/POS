/**
 * RT-17 slice 4 part 3 — the shift notice in the v5 frame: the "shift
 * required" gate for a cashier (a prominent banner, selling NOT blocked), the
 * way in for a manager, and nothing at all while the flag is off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ShiftNotice } from '../shift/ShiftNotice';
import { SHIFT_COPY } from '../shift/shift-copy';
import {
  enableShiftFlag,
  fakeShiftBridge,
  openShiftView,
  renderAt,
  resetShiftStores,
  signIn,
  statusView,
} from './__helpers__/shift-test-kit';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

function renderNotice(bridge: ReturnType<typeof fakeShiftBridge> | null, path = '/app/cart') {
  return renderAt({ path, pattern: '/app/*', element: <ShiftNotice bridge={bridge} /> });
}

describe('ShiftNotice — hidden entirely while the flag is off', () => {
  it.each(['cashier', 'manager', 'admin'] as const)(
    'renders nothing and calls nothing for a %s with the flag off',
    async (role) => {
      signIn(role);
      enableShiftFlag(false);
      const bridge = fakeShiftBridge();
      const { container } = renderNotice(bridge);
      await Promise.resolve();
      expect(container).toBeEmptyDOMElement();
      expect(bridge.status).not.toHaveBeenCalled();
    },
  );

  it('renders nothing before the flags are hydrated', () => {
    signIn('cashier');
    const bridge = fakeShiftBridge();
    const { container } = renderNotice(bridge);
    expect(container).toBeEmptyDOMElement();
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it('renders nothing when signed out or without a shift bridge', () => {
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    expect(renderNotice(bridge).container).toBeEmptyDOMElement();
    cleanup();
    signIn('cashier');
    expect(renderNotice(null).container).toBeEmptyDOMElement();
    expect(bridge.status).not.toHaveBeenCalled();
  });
});

describe('ShiftNotice — the cashier’s "shift required" gate', () => {
  it('shows a prominent banner with the way to open a shift when none is open', async () => {
    signIn('cashier');
    enableShiftFlag();
    renderNotice(fakeShiftBridge());
    const banner = await screen.findByTestId('shift-gate-banner');
    expect(banner).toHaveTextContent(SHIFT_COPY.gateBanner);
    expect(screen.getByRole('link', { name: SHIFT_COPY.gateAction })).toHaveAttribute(
      'href',
      '/app/shift',
    );
  });

  it('is quiet with an open shift: one link to manage it, no banner', async () => {
    signIn('cashier');
    enableShiftFlag();
    renderNotice(fakeShiftBridge(statusView({ openShift: openShiftView() })));
    expect(await screen.findByRole('link', { name: SHIFT_COPY.manageShift })).toHaveAttribute(
      'href',
      '/app/shift',
    );
    expect(screen.queryByTestId('shift-gate-banner')).not.toBeInTheDocument();
  });

  it('still offers the shift screen when the status cannot be read', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    bridge.status.mockResolvedValue({ kind: 'refused', reason: 'unavailable' });
    renderNotice(bridge);
    expect(await screen.findByRole('link', { name: SHIFT_COPY.manageShift })).toBeInTheDocument();
    expect(screen.queryByTestId('shift-gate-banner')).not.toBeInTheDocument();
  });

  it('treats a rejected status call like a refused one', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    bridge.status.mockRejectedValue(new Error('ipc'));
    renderNotice(bridge);
    expect(await screen.findByRole('link', { name: SHIFT_COPY.manageShift })).toBeInTheDocument();
  });

  it('stays off the shift screens themselves', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    const { container } = renderNotice(bridge, '/app/shift');
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(bridge.status).not.toHaveBeenCalled();
  });
});

describe('ShiftNotice — the manager’s way in', () => {
  it.each(['manager', 'admin'] as const)(
    'offers a %s the shift status, and reads nothing for it',
    async (role) => {
      signIn(role);
      enableShiftFlag();
      const bridge = fakeShiftBridge();
      renderNotice(bridge);
      expect(screen.getByRole('link', { name: SHIFT_COPY.managerLink })).toHaveAttribute(
        'href',
        '/app/shift/manager',
      );
      await waitFor(() => {
        expect(bridge.status).not.toHaveBeenCalled();
      });
      expect(screen.queryByTestId('shift-gate-banner')).not.toBeInTheDocument();
    },
  );
});
