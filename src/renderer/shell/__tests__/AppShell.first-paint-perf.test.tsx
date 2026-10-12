/**
 * T062a — NFR-4 first-paint performance-budget smoke test.
 *
 * Spec NFR-4: AppShell first paint <= 500 ms from mocked paired-bridge
 * resolve to <main> landmark visible.
 *
 * Architecture note: The AppRouter boot state machine always resolves a paired
 * bridge to /paired (PairedScreen), not directly to /app/* (AppShell). The
 * perf budget test therefore renders AppShell directly via MemoryRouter —
 * the same pattern used by AppShell.test.tsx — to accurately measure AppShell
 * first-paint time (NFR-4). Two companion tests cover the AppRouter boot
 * pipeline: bridge.getStatus() call count, and <main> landmark presence.
 *
 * Threshold policy:
 *   - CI hard limit: NFR_4_BUDGET_MS = 500 (the spec contract; not softened).
 *   - Local diagnostic override: set env NFR_4_BUDGET_MS_LOCAL_DIAG to a
 *     higher value during dev to surface flakiness without failing. The
 *     diagnostic threshold is informational only and MUST NOT weaken the
 *     CI contract.
 *
 * Scope guarantees:
 *   - Pure renderer; no fetch, no window.api beyond pairing.getStatus,
 *     no new bridge namespace, no persistence, no Figma artifact.
 *   - Uses Vitest 4 + RTL 16 + happy-dom 20 + performance.now().
 *   - No new runtime dependencies.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

import { AppShell } from '../AppShell';
import { AppRouter } from '../../router';
import type { PairingBridgeAPI } from '../../../shared/bridge-api';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/** NFR-4 hard CI budget in milliseconds (spec contract). */
const NFR_4_BUDGET_MS: number = 500;

/**
 * Optional local diagnostic threshold. When set via env variable, failures
 * between NFR_4_BUDGET_MS and this value emit a warning to aid local dev
 * investigation. The CI assertion uses NFR_4_BUDGET_MS unconditionally.
 */
const localDiagThreshold: number | null = (() => {
  const raw =
    typeof process !== 'undefined' ? (process.env['NFR_4_BUDGET_MS_LOCAL_DIAG'] ?? '') : '';
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > NFR_4_BUDGET_MS ? parsed : null;
})();

interface BridgeFixture {
  bridge: PairingBridgeAPI;
  getStatus: ReturnType<typeof vi.fn>;
}

/**
 * Fake paired bridge — synchronous resolve matching the in-memory pattern
 * used by existing 002/003 tests. getStatus() returns a pre-resolved
 * Promise so RTL's render completes synchronously in happy-dom.
 *
 * getStatus is returned as a separate reference so tests can assert on
 * it directly without triggering the unbound-method lint rule.
 */
function makeFakePairedBridge(): BridgeFixture {
  const getStatus = vi.fn().mockResolvedValue({
    kind: 'paired',
    tenant_id: 'test-tenant',
    branch_id: 'test-branch',
    terminal_id: 'term-001',
    terminal_label: 'POS-001',
    paired_at: new Date().toISOString(),
  });
  const bridge: PairingBridgeAPI = {
    getStatus,
    pair: vi.fn(),
    unpair: vi.fn(),
  } as unknown as PairingBridgeAPI;
  return { bridge, getStatus };
}

beforeEach(() => {
  // Stub matchMedia so AppShell + NavRail work in happy-dom.
  // Returning matches:true for any query keeps the 'expanded' viewport tier.
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('1280') || query.includes('min-height'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

describe('AppShell first-paint perf budget (T062a / NFR-4)', () => {
  it('renders AppShell <main> landmark within NFR-4 budget (direct MemoryRouter mount)', async () => {
    // Render AppShell directly — the boot router always lands on /paired
    // first (PairedScreen), so direct MemoryRouter is the only path that
    // accurately measures AppShell first-paint time for NFR-4.
    const t0 = performance.now();

    render(
      <MemoryRouter initialEntries={['/app/dashboard']}>
        <Routes>
          <Route path="/app/*" element={<AppShell />}>
            <Route path="dashboard" element={<div data-testid="dashboard-outlet" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // findByRole('main') resolves when AppShell's <main> landmark is in the DOM.
    // In happy-dom with synchronous RTL render this completes in the current tick.
    await screen.findByRole('main');

    const t1 = performance.now();
    const elapsed = t1 - t0;
    const budget = NFR_4_BUDGET_MS;

    if (localDiagThreshold !== null && elapsed > budget) {
      // Emit a diagnostic hint for local investigation without blocking.
      // This path is unreachable in CI (env var not set there).
      const diagMsg =
        '[NFR-4 local diag] Elapsed ' +
        elapsed.toFixed(1) +
        ' ms exceeds CI budget (' +
        String(budget) +
        ' ms) but is within local diagnostic threshold (' +
        String(localDiagThreshold) +
        ' ms). Investigation recommended.';
      console.warn(diagMsg);
    }

    // Hard CI assertion — spec NFR-4 contract; not relaxed.
    const failMsg =
      'AppShell first paint took ' +
      elapsed.toFixed(1) +
      ' ms; NFR-4 budget is ' +
      String(budget) +
      ' ms';
    expect(elapsed, failMsg).toBeLessThanOrEqual(budget);
  });

  it('paired-boot pipeline renders a <main> landmark (AppRouter path)', async () => {
    // Tests the AppRouter boot path: bridge.getStatus() paired → /paired (PairedScreen).
    // PairedScreen renders a <main> landmark, satisfying the boot-pipeline contract.
    // This is separate from the AppShell NFR-4 perf test above.
    const { bridge } = makeFakePairedBridge();
    render(<AppRouter pairing={bridge} initialEntry="/" />);
    const main = await screen.findByRole('main');
    expect(main.tagName.toLowerCase()).toBe('main');
  });

  it('getStatus() is called exactly once during boot (no extra bridge calls)', async () => {
    const { bridge, getStatus } = makeFakePairedBridge();
    render(<AppRouter pairing={bridge} initialEntry="/" />);
    await screen.findByRole('main');
    // getStatus is a vi.fn() reference extracted from the fixture factory.
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});
