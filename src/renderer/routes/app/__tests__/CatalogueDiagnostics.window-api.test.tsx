import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { CatalogueDiagnostics } from '../CatalogueDiagnostics';

/**
 * RT-503 — in production the screen reads `window.api` (no injected bridge). A
 * bridge object rebuilt on every render would make the mount effect re-run on
 * every render, and each answer (a new object) would trigger the next render:
 * an endless read loop. The screen must read each thing once on mount.
 */

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

describe('CatalogueDiagnostics — reads window.api', () => {
  it('reads pairing, counts and freshness once on mount (no re-read loop)', async () => {
    const getStatus = vi.fn(() => Promise.resolve({ kind: 'unpaired' }));
    const counts = vi.fn(() => Promise.resolve({ kind: 'ok', products: 3, barcodes: 4 }));
    const freshness = vi.fn(() =>
      Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
    );
    (window as unknown as { api: unknown }).api = {
      pairing: { getStatus },
      catalogue: {
        counts,
        freshness,
        refresh: vi.fn(),
        search: vi.fn(),
      },
    };
    render(
      <MemoryRouter>
        <CatalogueDiagnostics />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('diagnostics-counts')).toHaveTextContent('3'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(counts).toHaveBeenCalledTimes(1);
    expect(freshness).toHaveBeenCalledTimes(1);
  });
});
