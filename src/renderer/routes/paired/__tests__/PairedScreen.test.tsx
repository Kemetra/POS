import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { READY_COPY } from '../../../v5/entry/entry-copy';
import { PairedScreen } from '../PairedScreen';
import type { PairingBridgeAPI } from '../../../../shared/bridge-api';
import type { PairingStatus } from '../../../../shared/pairing-types';

/**
 * 002-terminal-pairing T032 / S4-restyle — `PairedScreen` tests.
 *
 * The screen calls `bridge.pairing.getStatus()` itself on mount
 * (Option B from the readiness review): this decouples it from the
 * boot router's state machine, so a fresh navigation from the form
 * lands on a route that re-fetches its own data.
 *
 * S4 visual contract (T065): the screen shows a PAIRED pill, H1 "Ready",
 * and an identifier-free body line ("Connected. Choose Continue to open
 * the dashboard."). The data-terminal-label attribute on the root <main>
 * is retained as a human-friendly label; no backend IDs appear in visible
 * text or DOM attributes.
 *
 * Security policy: the `paired` PairingStatus branch type explicitly
 * omits `device_token`. The test injects a sentinel string into the
 * fake bridge's getStatus result and asserts the sentinel is absent
 * from the rendered DOM tree — even a future bug in the type would
 * be caught by this runtime assertion.
 */

const PAIRED_STATUS: Extract<PairingStatus, { kind: 'paired' }> = {
  kind: 'paired',
  tenant_id: 'tenant-A',
  branch_id: 'branch-B',
  terminal_id: 'terminal-C',
  terminal_label: 'Counter 1',
  paired_at: 1735689600,
};

interface BridgeFixture {
  bridge: PairingBridgeAPI;
  getStatus: ReturnType<typeof vi.fn<() => Promise<PairingStatus>>>;
}

function makeBridge(
  opts: {
    status?: PairingStatus;
    statusImpl?: () => Promise<PairingStatus>;
  } = {},
): BridgeFixture {
  const getStatus = vi.fn<() => Promise<PairingStatus>>(
    opts.statusImpl ?? (() => Promise.resolve(opts.status ?? PAIRED_STATUS)),
  );
  return {
    getStatus,
    bridge: {
      getStatus,
      submit: vi.fn(() => Promise.reject(new Error('PairedScreen must not call submit'))),
    },
  };
}

function renderInRouter(bridge: PairingBridgeAPI): { locations: string[] } {
  const locations: string[] = [];
  function LocationProbe(): null {
    const loc = useLocation();
    locations.push(loc.pathname);
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/paired']}>
      <Routes>
        <Route
          path="/paired"
          element={
            <>
              <PairedScreen pairing={bridge} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/pairing" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return { locations };
}

afterEach(() => {
  cleanup();
});

describe('PairedScreen — happy path (T032)', () => {
  it('calls bridge.pairing.getStatus() on mount', async () => {
    const { bridge, getStatus } = makeBridge();
    renderInRouter(bridge);
    await waitFor(() => {
      expect(getStatus).toHaveBeenCalledTimes(1);
    });
  });

  it('renders the G-1 Ready card: the M-F1 sentence, the terminal fact and «متابعة»', async () => {
    const { bridge } = makeBridge();
    renderInRouter(bridge);

    await waitFor(() => {
      expect(screen.getByTestId('route-paired')).toBeInTheDocument();
    });

    // RT-244 PR2 (G-1 «Ready», M-F1): the visible elements the operator reads.
    expect(screen.getByRole('heading', { level: 1, name: READY_COPY.title })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: READY_COPY.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: READY_COPY.continue })).toHaveFocus();
    expect(screen.queryByText(/PAIRED|Ready|Continue/)).not.toBeInTheDocument();
  });

  it('preserves the data-testid="route-paired" attribute (router test compatibility)', async () => {
    const { bridge } = makeBridge();
    renderInRouter(bridge);
    await waitFor(() => {
      expect(screen.getByTestId('route-paired')).toBeInTheDocument();
    });
  });

  it('preserves data-terminal-label but does NOT expose tenant/branch/terminal IDs', async () => {
    const { bridge } = makeBridge();
    renderInRouter(bridge);
    await waitFor(() => {
      const root = screen.getByTestId('route-paired');
      expect(root).toHaveAttribute('data-terminal-label', PAIRED_STATUS.terminal_label);
      expect(root).not.toHaveAttribute('data-tenant-id');
      expect(root).not.toHaveAttribute('data-branch-id');
      expect(root).not.toHaveAttribute('data-terminal-id');
    });
  });
});

describe('PairedScreen — security (T032)', () => {
  it('does NOT render device_token field name in the DOM', async () => {
    const { bridge } = makeBridge();
    renderInRouter(bridge);
    await waitFor(() => {
      expect(screen.getByTestId('route-paired')).toBeInTheDocument();
    });

    const root = screen.getByTestId('route-paired');
    const fullText = root.textContent;
    const fullHtml = root.outerHTML;
    // Even the literal label "device_token" must not appear — defense
    // in depth against a future helper component leaking the field name.
    expect(fullText).not.toContain('device_token');
    expect(fullHtml).not.toContain('device_token');
  });

  it('does NOT render a sentinel token-shaped string even if the bridge return type were ever to leak one', async () => {
    // Force-cast a bridge whose getStatus returns an object containing a
    // token-shaped property. The PairingStatus type prohibits this at
    // compile time; the runtime test pins the contract regardless.
    const sentinel = 'OPAQUE-TOKEN-SENTINEL-9876';
    const leakyStatus = {
      ...PAIRED_STATUS,
      // Deliberately injected to prove the runtime guard. The
      // PairingStatus type does not declare device_token; this cast
      // simulates a future bug or backend leak.
      device_token: sentinel,
    } as Extract<PairingStatus, { kind: 'paired' }>;
    const { bridge } = makeBridge({ status: leakyStatus });
    renderInRouter(bridge);
    await waitFor(() => {
      expect(screen.getByTestId('route-paired')).toBeInTheDocument();
    });

    const root = screen.getByTestId('route-paired');
    expect(root.textContent).not.toContain(sentinel);
    expect(root.outerHTML).not.toContain(sentinel);
  });
});

describe('PairedScreen — minimum disclosure (F-2)', () => {
  it('does not render tenant_id, branch_id, or terminal_id in DOM attributes or text', async () => {
    const { bridge } = makeBridge();
    renderInRouter(bridge);
    await waitFor(() => {
      expect(screen.getByTestId('route-paired')).toBeInTheDocument();
    });
    const root = screen.getByTestId('route-paired');
    const html = root.outerHTML;
    expect(html).not.toContain('data-tenant-id');
    expect(html).not.toContain('data-branch-id');
    expect(html).not.toContain('data-terminal-id');
    expect(html).not.toContain(PAIRED_STATUS.tenant_id);
    expect(html).not.toContain(PAIRED_STATUS.terminal_id);
    // branch_id value must not appear in DOM text either
    expect(root.textContent).not.toContain(PAIRED_STATUS.branch_id);
  });

  it('shows terminal_label only as the card fact, isolated, never inside a sentence', async () => {
    const { bridge } = makeBridge();
    renderInRouter(bridge);
    await waitFor(() => {
      expect(screen.getByTestId('route-paired')).toBeInTheDocument();
    });
    // G-1 «Ready» (owner-approved): the label is admin free text, the one fact
    // shown, in <bdi> so a Latin label cannot reorder the Arabic around it.
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain(
      PAIRED_STATUS.terminal_label,
    );
    const fact = screen.getByText(PAIRED_STATUS.terminal_label);
    expect(fact.tagName).toBe('BDI');
    expect(fact.closest('dd')?.previousElementSibling?.textContent).toBe(READY_COPY.terminal);
  });
});

describe('PairedScreen — production fallback to window.api', () => {
  it('reads bridge from window.api when no `pairing` prop is provided', async () => {
    const fakeApi = {
      ping: vi.fn(),
      appVersion: vi.fn(),
      log: vi.fn(),
      appConfig: vi.fn(),
      pairing: {
        getStatus: vi.fn(() => Promise.resolve(PAIRED_STATUS)),
        submit: vi.fn(),
      },
    };
    const original = (window as unknown as { api?: unknown }).api;
    (window as unknown as { api: typeof fakeApi }).api = fakeApi;
    try {
      render(
        <MemoryRouter initialEntries={['/paired']}>
          {/* No `pairing` prop — must fall through to window.api */}
          <PairedScreen />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId('route-paired')).toBeInTheDocument();
      });
    } finally {
      if (original === undefined) delete (window as unknown as { api?: unknown }).api;
      else (window as unknown as { api?: unknown }).api = original;
    }
  });

  it('throws a clear error when no `pairing` prop AND window.api is missing', () => {
    const original = (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { api?: unknown }).api;
    try {
      expect(() => {
        render(
          <MemoryRouter initialEntries={['/paired']}>
            <PairedScreen />
          </MemoryRouter>,
        );
      }).toThrow(/window\.api missing/);
    } finally {
      if (original !== undefined) (window as unknown as { api?: unknown }).api = original;
    }
  });
});

describe('PairedScreen — defensive recovery (T033)', () => {
  it('shows a loading affordance while getStatus() is pending', () => {
    const pending = new Promise<PairingStatus>(() => {
      /* never resolve */
    });
    const { bridge } = makeBridge({ statusImpl: () => pending });
    renderInRouter(bridge);

    // While pending, EITHER:
    //  - the route-paired root is not yet in the DOM, OR
    //  - a loading sentinel is shown.
    // Either is acceptable; the assertion below covers both.
    expect(
      screen.queryByTestId('route-paired-loading') ?? screen.queryByTestId('route-paired'),
    ).toBeInTheDocument();
  });

  it('redirects to /pairing when getStatus() resolves to unpaired (defensive)', async () => {
    const { bridge } = makeBridge({ status: { kind: 'unpaired' } });
    const { locations } = renderInRouter(bridge);
    await waitFor(() => {
      expect(locations).toContain('/pairing');
    });
  });

  it('redirects to /pairing when getStatus() resolves to invalid (defensive)', async () => {
    const { bridge } = makeBridge({
      status: { kind: 'invalid', reason: 'missing_token' },
    });
    const { locations } = renderInRouter(bridge);
    await waitFor(() => {
      expect(locations).toContain('/pairing');
    });
  });

  it('redirects to /pairing when getStatus() rejects (defensive — same recovery surface)', async () => {
    const { bridge } = makeBridge({
      statusImpl: () => Promise.reject(new Error('bridge boom')),
    });
    const { locations } = renderInRouter(bridge);
    await waitFor(() => {
      expect(locations).toContain('/pairing');
    });
  });
});
