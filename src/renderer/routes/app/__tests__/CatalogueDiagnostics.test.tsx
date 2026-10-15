import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { CatalogueDiagnostics } from '../CatalogueDiagnostics';
import type {
  CatalogueCountsResponse,
  CatalogueFreshnessResponse,
  CatalogueRefreshResponse,
  CatalogueSearchResponse,
} from '../../../../shared/bridge-api.js';
import type { PairingStatus } from '../../../../shared/pairing-types';
import { formatHumanDateTime } from '../../../ui/format/human-format';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';

/**
 * 010 diagnostics, RT-503 (VN-S10 S10-6, G-6 state 12) — the read-only
 * Catalogue Diagnostics screen, in Arabic. Same bridge calls as before:
 *   - pairing.getStatus() -> tenant/branch/terminal identifiers (NEVER the token).
 *   - catalogue.counts()  -> products + barcode-alias counts.
 *   - catalogue.freshness()/refresh() -> sync state + manual refresh.
 *   - catalogue.search()  -> read-only local search (from 2 characters).
 * Bridges are injected (the established `_testBridge` seam).
 */

const SYNC_ISO = '2026-06-16T12:37:42.035Z';

const PAIRED: Extract<PairingStatus, { kind: 'paired' }> = {
  kind: 'paired',
  tenant_id: 'tenant-A',
  branch_id: 'store-1',
  terminal_id: 'term-9',
  terminal_label: 'Pilot Counter 1',
} as Extract<PairingStatus, { kind: 'paired' }>;

function bridge(over: {
  status?: () => Promise<PairingStatus>;
  counts?: () => Promise<CatalogueCountsResponse>;
  freshness?: () => Promise<CatalogueFreshnessResponse>;
  refresh?: () => Promise<CatalogueRefreshResponse>;
  search?: () => Promise<CatalogueSearchResponse>;
}) {
  // Flat method handles — mirrors the DiagnosticsBridge seam (no nested namespaces).
  return {
    getStatus: over.status ?? (() => Promise.resolve(PAIRED)),
    counts:
      over.counts ??
      (() => Promise.resolve({ kind: 'ok' as const, products: 12480, barcodes: 15902 })),
    freshness:
      over.freshness ??
      (() => Promise.resolve({ kind: 'ok' as const, last_success_at: SYNC_ISO, is_empty: false })),
    refresh: over.refresh ?? (() => Promise.resolve({ kind: 'started' as const })),
    search: over.search ?? (() => Promise.resolve({ kind: 'not_found' as const })),
  };
}

function renderScreen(b: ReturnType<typeof bridge>) {
  return render(
    <MemoryRouter>
      <CatalogueDiagnostics bridge={b} />
    </MemoryRouter>,
  );
}

async function settled(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('diagnostics-counts')).toHaveTextContent('12,480'));
}

const SEARCH_LABEL = 'ابحث بالاسم أو الباركود';
const REFRESH_LABEL = 'تحديث الآن';

afterEach(() => {
  cleanup();
});

describe('CatalogueDiagnostics — frame and copy', () => {
  it('titles the page «فحص الكتالوج» with the read-only sub-line', async () => {
    renderScreen(bridge({}));
    expect(screen.getByRole('heading', { level: 1, name: 'فحص الكتالوج' })).toBeInTheDocument();
    expect(screen.getByText('للقراءة فقط. لا يغيّر شيئًا في الكتالوج.')).toBeInTheDocument();
    await settled();
  });

  it('has the four G-6 panels, each a named region', async () => {
    renderScreen(bridge({}));
    await settled();
    for (const name of [
      'هذا الجهاز',
      'مزامنة الكتالوج',
      'البيانات المحلية',
      'بحث في الكتالوج المحلي',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('has no «Coming soon» stock section and no English visible copy', async () => {
    const { container } = renderScreen(bridge({}));
    await settled();
    expect(screen.queryByTestId('diagnostics-stock-coming-soon')).not.toBeInTheDocument();
    // Ids and the free-text terminal label are the only Latin text allowed.
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.v5-manager-id, bdi').forEach((n) => {
      n.remove();
    });
    expect(clone.textContent).not.toMatch(/[A-Za-z]/);
  });

  it('is axe-clean', async () => {
    const { container } = renderScreen(bridge({}));
    await settled();
    await expectNoAxeViolations(container);
  });
});

describe('CatalogueDiagnostics — this device', () => {
  it('shows the tenant, branch and terminal ids and the terminal name', async () => {
    renderScreen(bridge({}));
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-pairing')).toHaveTextContent('tenant-A'),
    );
    const panel = within(screen.getByTestId('diagnostics-pairing'));
    expect(panel.getByText('المستأجر')).toBeInTheDocument();
    expect(panel.getByText('الفرع')).toBeInTheDocument();
    expect(panel.getByText('الجهاز')).toBeInTheDocument();
    expect(panel.getByText('اسم الجهاز')).toBeInTheDocument();
    expect(panel.getByText('store-1')).toBeInTheDocument();
    expect(panel.getByText('term-9')).toBeInTheDocument();
    expect(panel.getByText('Pilot Counter 1')).toBeInTheDocument();
  });

  it('shows «الجهاز غير مقترن.» when pairing status is not paired', async () => {
    renderScreen(bridge({ status: () => Promise.resolve({ kind: 'unpaired' } as never) }));
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-pairing')).toHaveTextContent('الجهاز غير مقترن.'),
    );
  });

  it('NEVER renders a device token (no secret in text or DOM attributes)', async () => {
    const { container } = renderScreen(
      bridge({
        status: () =>
          Promise.resolve({ ...PAIRED, device_token: 'tok_SECRET_should_never_render' } as never),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-pairing')).toHaveTextContent('tenant-A'),
    );
    expect(container.innerHTML).not.toContain('tok_SECRET_should_never_render');
    expect(container.innerHTML).not.toContain('device_token');
  });
});

describe('CatalogueDiagnostics — local data', () => {
  it('shows the product and barcode counts as grouped numbers', async () => {
    renderScreen(bridge({}));
    await settled();
    const panel = within(screen.getByTestId('diagnostics-counts'));
    expect(panel.getByText('الأصناف')).toBeInTheDocument();
    expect(panel.getByText('الباركود والأسماء البديلة')).toBeInTheDocument();
    expect(panel.getByText('15,902')).toBeInTheDocument();
  });

  it('shows «غير متاح» when catalogue.counts is refused', async () => {
    renderScreen(
      bridge({ counts: () => Promise.resolve({ kind: 'refused', reason: 'no_session' }) }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-counts')).toHaveTextContent('غير متاح'),
    );
  });
});

describe('CatalogueDiagnostics — sync and refresh', () => {
  it('shows the last update with the shared formatter', async () => {
    renderScreen(bridge({}));
    const expected = formatHumanDateTime(SYNC_ISO, { withYear: true }) as string;
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-sync-state')).toHaveTextContent(expected),
    );
    expect(screen.getByText('آخر تحديث')).toBeInTheDocument();
  });

  it('freshness: never synced shows «لم يُحدَّث بعد»', async () => {
    renderScreen(
      bridge({
        freshness: () => Promise.resolve({ kind: 'ok', last_success_at: null, is_empty: true }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-sync-state')).toHaveTextContent('لم يُحدَّث بعد'),
    );
  });

  it('freshness: synced but empty shows «حُدِّث ولا توجد أصناف»', async () => {
    renderScreen(
      bridge({
        freshness: () => Promise.resolve({ kind: 'ok', last_success_at: SYNC_ISO, is_empty: true }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-sync-state')).toHaveTextContent(
        'حُدِّث ولا توجد أصناف',
      ),
    );
  });

  it('freshness: refused shows «غير متاح»', async () => {
    renderScreen(
      bridge({ freshness: () => Promise.resolve({ kind: 'refused', reason: 'no_session' }) }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-sync-state')).toHaveTextContent('غير متاح'),
    );
  });

  it.each([
    [{ kind: 'started' }, 'بدأ التحديث.'],
    [{ kind: 'already_running' }, 'التحديث جارٍ بالفعل.'],
    [{ kind: 'refused', reason: 'no_session' }, 'تعذّر بدء التحديث.'],
  ] as const)('«تحديث الآن» with %j shows «%s»', async (res, text) => {
    const refresh = vi.fn(() => Promise.resolve(res as CatalogueRefreshResponse));
    renderScreen(bridge({ refresh }));
    await userEvent.click(await screen.findByRole('button', { name: REFRESH_LABEL }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-refresh-status')).toHaveTextContent(text),
    );
  });

  it('a rejected refresh says «تعذّر بدء التحديث.» and never claims completion', async () => {
    const refresh = vi.fn(() => Promise.reject(new Error('boom')));
    renderScreen(bridge({ refresh }));
    await userEvent.click(await screen.findByRole('button', { name: REFRESH_LABEL }));
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-refresh-status')).toHaveTextContent(
        'تعذّر بدء التحديث.',
      ),
    );
  });

  it('after a refresh, freshness and counts are read again (calls unchanged)', async () => {
    const freshness = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, last_success_at: SYNC_ISO, is_empty: false }),
    );
    const counts = vi.fn(() => Promise.resolve({ kind: 'ok' as const, products: 1, barcodes: 1 }));
    renderScreen(bridge({ freshness, counts }));
    await waitFor(() => {
      expect(freshness).toHaveBeenCalledTimes(1);
    });
    await userEvent.click(await screen.findByRole('button', { name: REFRESH_LABEL }));
    await waitFor(() => {
      expect(freshness).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(counts).toHaveBeenCalledTimes(2);
    });
  });
});

describe('CatalogueDiagnostics — search', () => {
  it('a >=2-char query calls catalogue.search and shows the Arabic count', async () => {
    const search = vi.fn(() =>
      Promise.resolve({
        kind: 'results' as const,
        items: Array.from({ length: 12 }, (_, i) => ({ product_id: `p-${String(i)}` })) as never,
        truncated: false,
      }),
    );
    renderScreen(bridge({ search }));
    const input = await screen.findByLabelText(SEARCH_LABEL);
    await userEvent.type(input, 'para');
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith({ query: 'para' });
    });
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-search-results')).toHaveTextContent('12 نتيجة'),
    );
  });

  it('one result follows the Arabic plural rule', async () => {
    const search = vi.fn(() =>
      Promise.resolve({
        kind: 'results' as const,
        items: [{ product_id: 'p-1' }] as never,
        truncated: false,
      }),
    );
    renderScreen(bridge({ search }));
    await userEvent.type(await screen.findByLabelText(SEARCH_LABEL), 'para');
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-search-results')).toHaveTextContent('نتيجة واحدة'),
    );
  });

  it('not found shows «لا توجد نتائج»', async () => {
    renderScreen(bridge({ search: () => Promise.resolve({ kind: 'not_found' }) }));
    await userEvent.type(await screen.findByLabelText(SEARCH_LABEL), 'zz');
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-search-results')).toHaveTextContent('لا توجد نتائج'),
    );
  });

  it('refused shows «غير متاح»', async () => {
    renderScreen(
      bridge({ search: () => Promise.resolve({ kind: 'refused', reason: 'no_session' }) }),
    );
    await userEvent.type(await screen.findByLabelText(SEARCH_LABEL), 'zz');
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-search-results')).toHaveTextContent('غير متاح'),
    );
  });

  it('a rejected bridge call shows «غير متاح» (never throws)', async () => {
    const search = vi.fn(() => Promise.reject(new Error('boom')));
    renderScreen(bridge({ search }));
    await userEvent.type(await screen.findByLabelText(SEARCH_LABEL), 'para');
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-search-results')).toHaveTextContent('غير متاح'),
    );
  });

  it('a sub-2-char query never calls the bridge (short-circuit)', async () => {
    const search = vi.fn(() => Promise.resolve({ kind: 'not_found' as const }));
    renderScreen(bridge({ search }));
    const input = await screen.findByLabelText(SEARCH_LABEL);
    await userEvent.type(input, 'p');
    await waitFor(() => expect(input).toHaveValue('p'));
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByTestId('diagnostics-search-results')).toBeEmptyDOMElement();
  });

  it('read-only: the page offers one button, the refresh', async () => {
    renderScreen(bridge({}));
    await screen.findByRole('button', { name: REFRESH_LABEL });
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
