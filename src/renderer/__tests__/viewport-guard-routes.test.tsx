import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../router';
import { installViewport, resizeTo, settleTier } from '../v5/__tests__/__helpers__/viewport-bands';
import type { OperatorBridgeAPI, PairingBridgeAPI } from '../../shared/bridge-api';
import type { PairingStatus } from '../../shared/pairing-types';

/**
 * RT-241 (VNext W1-A, VN-S2) — pairing, the Ready screen and sign-in sit
 * outside the V5 frame, so before this slice they had no supported-viewport
 * guard. Below 1024px they now show only the Arabic ScreenTooSmall notice. The
 * guard wraps the route ELEMENT only: the boot read still runs exactly once, so
 * pairing semantics are unchanged.
 */

const TOO_SMALL_HEADING = /^الشاشة أصغر من 1024×768\s?\.$/;

function stubViewport(width: number, height = 800): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const minWidth = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? '0');
      const minHeight = Number(/min-height:\s*(\d+)px/.exec(query)?.[1] ?? '0');
      return {
        matches: width >= minWidth && height >= minHeight,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  );
}

function bridgeWith(status: PairingStatus): {
  bridge: PairingBridgeAPI;
  getStatus: ReturnType<typeof vi.fn>;
} {
  const getStatus = vi.fn(() => Promise.resolve(status));
  return {
    getStatus,
    bridge: { getStatus, submit: vi.fn(() => Promise.reject(new Error('unused'))) },
  };
}

const PAIRED: PairingStatus = {
  kind: 'paired',
  tenant_id: 'tenant-A',
  branch_id: 'branch-B',
  terminal_id: 'terminal-C',
  terminal_label: 'Counter 1',
  paired_at: 1735689600,
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('supported-viewport guard outside the frame', () => {
  it('pairing at 1023px shows only the too-small notice; the boot read still runs once', async () => {
    stubViewport(1023);
    const { bridge, getStatus } = bridgeWith({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);

    expect(await screen.findByRole('heading', { name: TOO_SMALL_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('route-pairing')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/pairing');
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('the Ready screen at 1023px shows only the too-small notice', async () => {
    stubViewport(1023);
    const { bridge } = bridgeWith(PAIRED);
    render(<AppRouter pairing={bridge} />);

    expect(await screen.findByRole('heading', { name: TOO_SMALL_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('route-paired')).not.toBeInTheDocument();
  });

  it('sign-in at 1023px shows only the too-small notice and never mounts the sign-in screen', async () => {
    stubViewport(1023);
    const { bridge } = bridgeWith(PAIRED);
    // An empty operator bridge: any sign-in mount would call into it and throw.
    render(
      <AppRouter pairing={bridge} operator={{} as OperatorBridgeAPI} initialEntry="/sign-in" />,
    );

    expect(await screen.findByRole('heading', { name: TOO_SMALL_HEADING })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('at 1024px pairing renders as before', async () => {
    stubViewport(1024);
    const { bridge } = bridgeWith({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: TOO_SMALL_HEADING })).not.toBeInTheDocument();
  });
});

/**
 * RT-313 (RT-312 D1/D5) — the 600px height floor applies outside the frame
 * too, with the height copy, and the boot read is still unchanged.
 */
const HEIGHT_HEADING = 'ارتفاع الشاشة أقل من الحد المدعوم.';

describe('supported-viewport height floor outside the frame (RT-313)', () => {
  it('pairing at 599px high shows only the height notice; the boot read still runs once', async () => {
    stubViewport(1280, 599);
    const { bridge, getStatus } = bridgeWith({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);

    expect(await screen.findByRole('heading', { name: HEIGHT_HEADING })).toBeInTheDocument();
    expect(screen.queryByTestId('route-pairing')).not.toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('sign-in at 599px high never mounts the sign-in screen', async () => {
    stubViewport(1024, 599);
    const { bridge } = bridgeWith(PAIRED);
    render(
      <AppRouter pairing={bridge} operator={{} as OperatorBridgeAPI} initialEntry="/sign-in" />,
    );

    expect(await screen.findByRole('heading', { name: HEIGHT_HEADING })).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('the Ready screen at 600px high renders as before', async () => {
    stubViewport(1024, 600);
    const { bridge } = bridgeWith(PAIRED);
    render(<AppRouter pairing={bridge} />);

    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: HEIGHT_HEADING })).not.toBeInTheDocument();
  });

  it('back over the floor, focus is in the remounted pairing screen, never on <body>', async () => {
    installViewport(1280, 800);
    const { bridge } = bridgeWith({ kind: 'unpaired' });
    render(<AppRouter pairing={bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-pairing')).toBeInTheDocument());

    resizeTo(1280, 599);
    await settleTier();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: HEIGHT_HEADING }));

    resizeTo(1280, 800);
    await settleTier();
    const pairing = screen.getByTestId('route-pairing');
    expect(document.activeElement).not.toBe(document.body);
    expect(pairing.contains(document.activeElement)).toBe(true);
  });

  it('the Ready screen remounts through a loading state: focus stays in the guard, never on <body>', async () => {
    installViewport(1280, 800);
    const { bridge } = bridgeWith(PAIRED);
    render(<AppRouter pairing={bridge} />);
    await waitFor(() => expect(screen.getByTestId('route-paired')).toBeInTheDocument());

    resizeTo(1280, 599);
    await settleTier();
    resizeTo(1280, 800);
    await settleTier();
    const ready = await screen.findByTestId('route-paired');
    const box = ready.closest('.v5-supported-viewport');
    expect(box).not.toBeNull();
    // RT-244 PR2: Ready autofocuses its one commit («متابعة»), so focus lands
    // there on remount, still inside the guard and never on <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(box?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toHaveAttribute('data-testid', 'paired-continue');
    // Programmatically focusable, but not a Tab stop.
    expect(box).toHaveAttribute('tabindex', '-1');
  });
});
