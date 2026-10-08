import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { V5Frame } from '../frame/V5Frame';
import { V5_SALE_PATH } from '../frame/nav-model';
import { installViewport, resizeTo, settleTier } from './__helpers__/viewport-bands';

/**
 * RT-241 responsive preflight (2026-10-08) — the supported geometry is
 * 1024×768 (compact) and 1280×800 (comfortable), measured as the renderer's
 * effective CSS viewport. Below 1024 the frame shows only the Arabic M-F2
 * notice, never a blank or English screen. The breakpoint and the 100 ms tier
 * debounce are unchanged; no sub-1024 cashier layout is approved.
 */

const TOO_SMALL = /^الشاشة أصغر من 1024×768\s?\.$/;

function signInCashier(): void {
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: 'session-1',
    operator_id: 'op-1',
    display_name: 'صيدلي',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-08T09:00:00Z',
  });
}

function renderFrame(): void {
  render(
    <MemoryRouter initialEntries={[V5_SALE_PATH]}>
      <V5Frame>
        <section aria-labelledby="screen-title">
          <h1 id="screen-title">مساحة البيع</h1>
        </section>
      </V5Frame>
    </MemoryRouter>,
  );
}

function showsScreen(): boolean {
  return screen.queryByRole('heading', { name: 'مساحة البيع' }) !== null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useOperatorSessionStore.getState().reset();
});

describe('V5 frame at the effective-width boundaries', () => {
  it('1023px: only the Arabic M-F2 notice — not blank, not English, no frame', () => {
    installViewport(1023);
    signInCashier();
    renderFrame();
    expect(screen.getByRole('heading', { level: 1, name: TOO_SMALL })).toBeInTheDocument();
    expect(screen.getByText('كبّر النافذة أو استخدم شاشة أكبر.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(showsScreen()).toBe(false);
    expect(document.body.textContent).not.toMatch(/Screen too small|1024px wide/);
  });

  it.each([1024, 1279, 1280])('%ipx: the frame, its navigation and the screen', (width) => {
    installViewport(width);
    signInCashier();
    renderFrame();
    expect(screen.queryByRole('heading', { name: TOO_SMALL })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'نقطة البيع' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تسجيل الخروج' })).toBeInTheDocument();
    expect(showsScreen()).toBe(true);
  });
});

describe('V5 frame across the 100 ms tier transition', () => {
  it('1280 → 1023 → 1024 → 1280: the notice replaces the screen only after the debounce, and the screen returns', () => {
    vi.useFakeTimers();
    try {
      installViewport(1280);
      signInCashier();
      renderFrame();
      expect(showsScreen()).toBe(true);

      resizeTo(1023);
      act(() => {
        vi.advanceTimersByTime(99);
      });
      expect(showsScreen()).toBe(true); // still inside the debounce
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(showsScreen()).toBe(false);
      expect(screen.getByRole('heading', { name: TOO_SMALL })).toBeInTheDocument();

      resizeTo(1024);
      act(() => {
        vi.advanceTimersByTime(101);
      });
      expect(showsScreen()).toBe(true);
      expect(screen.queryByRole('heading', { name: TOO_SMALL })).not.toBeInTheDocument();

      resizeTo(1280);
      act(() => {
        vi.advanceTimersByTime(101);
      });
      expect(showsScreen()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('crossing within the supported range (1280 → 1024) never shows the notice', async () => {
    installViewport(1280);
    signInCashier();
    renderFrame();
    resizeTo(1024);
    await settleTier();
    expect(showsScreen()).toBe(true);
    expect(screen.queryByRole('heading', { name: TOO_SMALL })).not.toBeInTheDocument();
  });
});
