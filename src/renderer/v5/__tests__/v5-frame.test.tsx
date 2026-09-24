import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import type { Role } from '../../../shared/operator/role';
import { V5Frame } from '../frame/V5Frame';
import { V5_SALE_PATH, v5NavEntries } from '../frame/nav-model';
import { V5OperationalNotices } from '../frame/V5OperationalNotices';

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
});

function signIn(role: Role): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'د. سارة',
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-09-24T09:00:00Z',
  });
}

function renderFrame(path = V5_SALE_PATH): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <V5Frame>
        <section aria-labelledby="screen-title">
          <h1 id="screen-title">مساحة البيع</h1>
        </section>
      </V5Frame>
    </MemoryRouter>,
  );
}

describe('V5Frame — the one application frame for v5 screens', () => {
  it('owns exactly one main, one primary nav and one brand, in Arabic RTL', () => {
    signIn('manager');
    const { container } = renderFrame();

    const frame = screen.getByTestId('v5-frame');
    expect(frame).toHaveAttribute('dir', 'rtl');
    expect(frame).toHaveAttribute('lang', 'ar');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeInTheDocument();
    expect(screen.getAllByText('POS Pulse')).toHaveLength(1);
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1 })).toHaveTextContent(
      'مساحة البيع',
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('marks the Sale entry as the current page with an Arabic accessible name', () => {
    signIn('cashier');
    renderFrame();

    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    const sale = within(nav).getByRole('link', { name: 'نقطة البيع' });
    expect(sale).toHaveAttribute('aria-current', 'page');
    expect(sale).toHaveAttribute('href', V5_SALE_PATH);
    for (const link of within(nav).getAllByRole('link')) {
      if (link !== sale) expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('keeps the existing role filter: a cashier never sees Returns or Audit', () => {
    signIn('cashier');
    renderFrame();
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(nav).queryByRole('link', { name: 'المرتجعات' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'سجل المراجعة' })).not.toBeInTheDocument();
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
  });

  it('shows every entry to a manager; non-Sale entries keep their existing routes', () => {
    signIn('manager');
    renderFrame();
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(nav).getAllByRole('link')).toHaveLength(7);
    expect(within(nav).getByRole('link', { name: 'المرتجعات' })).toHaveAttribute(
      'href',
      '/app/returns',
    );
    expect(within(nav).getByRole('link', { name: 'لوحة المتابعة' })).toHaveAttribute(
      'href',
      '/app/dashboard',
    );
  });

  it('names the signed-in operator and role in Arabic, with no fabricated terminal identity', () => {
    signIn('manager');
    renderFrame();
    const operator = screen.getByTestId('v5-frame-operator');
    expect(operator).toHaveTextContent('د. سارة');
    expect(operator).toHaveTextContent('مدير');
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(screen.queryByText(/Online|Dark/)).not.toBeInTheDocument();
  });

  it('signed out: no operator block, and only the unrestricted entries', () => {
    renderFrame();
    expect(screen.queryByTestId('v5-frame-operator')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'التنقل الرئيسي' })).queryAllByRole('link'),
    ).toHaveLength(5);
  });

  it('renders a notices slot above the screen when given one', () => {
    signIn('manager');
    render(
      <MemoryRouter initialEntries={[V5_SALE_PATH]}>
        <V5Frame notices={<p>تنبيه تشغيلي</p>}>
          <p>محتوى</p>
        </V5Frame>
      </MemoryRouter>,
    );
    const notices = screen.getByTestId('v5-frame-notices');
    expect(notices).toHaveTextContent('تنبيه تشغيلي');
    expect(notices.compareDocumentPosition(screen.getByRole('main'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('is axe-clean with a signed-in manager', async () => {
    signIn('manager');
    const { container } = renderFrame();
    await expectNoAxeViolations(container);
  });
});

describe('V5OperationalNotices — the same operational banners the app frame must keep', () => {
  it('shows the forced shift-close notice from the existing session store', () => {
    useOperatorSessionStore.setState({
      state: {
        kind: 'signedIn',
        session: {
          id: 'session-1',
          operator_id: 'op-1',
          display_name: 'د. سارة',
          role: 'cashier',
          tenant_id: 'tenant-1',
          branch_id: 'branch-1',
          started_at: '2026-09-24T09:00:00Z',
        },
        forced_close_notice: { closed_at: '2026-09-24T08:00:00Z' },
      },
    });
    render(<V5OperationalNotices />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('surfaces printer and drawer failures from the existing banner-state poll, and keeps every entry point live', async () => {
    const subscribe = vi.fn(() =>
      Promise.resolve({
        kind: 'ok',
        banner_state: {
          printer_failure: {
            sale_id: 's-1',
            failure_reason: 'offline',
            has_successful_print: true,
          },
          drawer_failure: { sale_id: 's-1', last_successful_open_at: '2026-09-24T08:00:00Z' },
        },
      }),
    );
    // Held open so a second click lands while the first call is in flight.
    const reprint = vi.fn(() => new Promise(() => undefined));
    const manualOverride = vi.fn(() => new Promise(() => undefined));
    (window as unknown as { api?: unknown }).api = {
      sales: { subscribe, unsubscribe: vi.fn(() => Promise.resolve()) },
      receipts: { reprint, manualOverride },
    };
    useOperatorSessionStore.setState({
      state: {
        kind: 'signedIn',
        session: {
          id: 'session-1',
          operator_id: 'op-1',
          display_name: 'د. سارة',
          role: 'cashier',
          tenant_id: 'tenant-1',
          branch_id: 'branch-1',
          started_at: '2026-09-24T09:00:00Z',
        },
        forced_close_notice: { closed_at: '2026-09-24T08:00:00Z' },
      },
    });
    try {
      render(<V5OperationalNotices />);
      expect(await screen.findByTestId('printer-failure-banner')).toBeInTheDocument();
      // Codex P2 (#462): recovery controls must reach the existing receipts
      // bridge, not a no-op; a double press while in flight fires once.
      const reprintButton = screen.getByRole('button', { name: 'نسخة — Reprint' });
      fireEvent.click(reprintButton);
      fireEvent.click(reprintButton);
      expect(reprint).toHaveBeenCalledOnce();
      expect(reprint).toHaveBeenCalledWith({
        sale_id: 's-1',
        idempotency_key: expect.any(String) as string,
      });

      const manualButton = within(await screen.findByTestId('drawer-failure-banner')).getByRole(
        'button',
        { name: 'إيصال يدوي — Manual receipt' },
      );
      fireEvent.click(manualButton);
      fireEvent.click(manualButton);
      expect(manualOverride).toHaveBeenCalledOnce();
      expect(manualOverride).toHaveBeenCalledWith({
        sale_id: 's-1',
        idempotency_key: expect.any(String) as string,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
      const state = useOperatorSessionStore.getState().state;
      expect(state.kind === 'signedIn' && state.forced_close_notice).toBeFalsy();
      expect(subscribe).toHaveBeenCalledWith({ topic: 'banner_state' });
    } finally {
      delete (window as unknown as { api?: unknown }).api;
    }
  });

  it('releases the in-flight lock after a failed recovery call, so the operator can retry', async () => {
    (window as unknown as { api?: unknown }).api = {
      sales: {
        subscribe: vi.fn(() =>
          Promise.resolve({
            kind: 'ok',
            banner_state: {
              drawer_failure: { sale_id: 's-2', last_successful_open_at: null },
            },
          }),
        ),
        unsubscribe: vi.fn(() => Promise.resolve()),
      },
      receipts: {
        reprint: vi.fn(() => Promise.reject(new Error('transport'))),
        manualOverride: vi.fn(() => Promise.reject(new Error('transport'))),
      },
    };
    const receipts = (
      window as unknown as { api: { receipts: { manualOverride: ReturnType<typeof vi.fn> } } }
    ).api.receipts;
    signIn('cashier');
    try {
      render(<V5OperationalNotices />);
      const button = within(await screen.findByTestId('drawer-failure-banner')).getByRole(
        'button',
        { name: 'إيصال يدوي — Manual receipt' },
      );
      fireEvent.click(button);
      await waitFor(() => {
        expect(receipts.manualOverride).toHaveBeenCalledTimes(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.click(button);
      expect(receipts.manualOverride).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('drawer-failure-banner')).toBeInTheDocument();
    } finally {
      delete (window as unknown as { api?: unknown }).api;
    }
  });

  it('renders nothing when there is no notice and no bridge, signed in or out', () => {
    const signedOut = render(<V5OperationalNotices />);
    expect(signedOut.container).toBeEmptyDOMElement();
    signedOut.unmount();

    signIn('cashier');
    const { container } = render(<V5OperationalNotices />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('v5 nav model', () => {
  it('derives from the existing seven-entry contract without changing it', () => {
    expect(v5NavEntries.map((e) => e.id)).toEqual([
      'dashboard',
      'cart',
      'sales',
      'returns',
      'audit',
      'inventory',
      'settings',
    ]);
    expect(v5NavEntries.find((e) => e.id === 'cart')?.path).toBe(V5_SALE_PATH);
  });
});

describe('live Sale presentation inside the frame', () => {
  it('lets a long cart product name wrap to two lines so drug strength stays visible', () => {
    const css = readFileSync(resolve(__dirname, '../sale/live-sale.css'), 'utf8');
    const rule = /\.v5-sale-cart-line \.v5-sale-line-product strong\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'cart line name rule').not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).toMatch(/-webkit-line-clamp:\s*2/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('v5 foundation CSS stays scoped to the v5 frame', () => {
  const css = ['../foundation/foundation.css', '../frame/frame.css'].map((p) =>
    readFileSync(resolve(__dirname, p), 'utf8'),
  );

  it('never styles bare elements or :root, so legacy screens are untouched after preview', () => {
    for (const source of css) {
      const selectors = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@(media|container)[^{]*\{/g, '')
        .split('{')
        .slice(0, -1)
        .map((chunk) => (chunk.split('}').pop() ?? '').trim())
        .filter((sel) => sel.length > 0 && !/^[\d.%]+$/.test(sel));
      for (const selector of selectors) {
        for (const part of selector.split(',')) {
          expect(part.trim(), part).toMatch(/^\.v5-/);
        }
      }
    }
  });

  it('keeps every frame control at the 44px target floor', () => {
    expect(css.join('\n')).toMatch(/--v5-target:\s*44px/);
    expect(css[1]).toMatch(/\.v5-frame__link\s*\{[^}]*min-block-size:\s*var\(--v5-target\)/);
  });
});
