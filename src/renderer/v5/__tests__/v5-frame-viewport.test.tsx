import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useRef, type JSX } from 'react';
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

/**
 * RT-313 (RT-312 D1/D2/D5) — the 600px height floor. Below it the frame shows
 * only the height notice; from 600 (the compact-height band, 600–767) up, Sale
 * and Checkout run. The same 100ms debounce applies, and on return focus lands
 * on a defined target, never on <body>.
 */
const HEIGHT_HEADING = 'ارتفاع الشاشة أقل من الحد المدعوم.';
const HEIGHT_ACTION = /^كبّر النافذة، أو اضبط مقياس العرض في Windows على 100% أو 125%\s?\.$/;

function noticeBody(): Element | null {
  return document.querySelector('.screen-too-small__body');
}

function frameMain(): Element | null {
  return document.querySelector('main.v5-frame__main');
}

describe('V5 frame at the height floor (RT-313)', () => {
  it.each([1024, 1280])('%i×599: only the height notice — no frame, no nav, no screen', (width) => {
    installViewport(width, 599);
    signInCashier();
    renderFrame();
    expect(screen.getByRole('heading', { level: 1, name: HEIGHT_HEADING })).toBeInTheDocument();
    expect(noticeBody()).toHaveTextContent(HEIGHT_ACTION);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(showsScreen()).toBe(false);
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it.each([
    [1024, 600],
    [1280, 600],
    [1280, 767],
    [1280, 768],
  ])('%i×%i: the frame, its navigation and the screen', (width, height) => {
    installViewport(width, height);
    signInCashier();
    renderFrame();
    expect(document.querySelector('.screen-too-small')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeInTheDocument();
    expect(showsScreen()).toBe(true);
  });

  it('1023×599: under both floors — the size heading with the height action', () => {
    installViewport(1023, 599);
    signInCashier();
    renderFrame();
    expect(screen.getByRole('heading', { level: 1, name: TOO_SMALL })).toBeInTheDocument();
    expect(noticeBody()).toHaveTextContent(HEIGHT_ACTION);
    expect(screen.queryByText('كبّر النافذة أو استخدم شاشة أكبر.')).not.toBeInTheDocument();
    expect(showsScreen()).toBe(false);
  });
});

describe('V5 frame across the height floor and combined crossings (RT-313)', () => {
  it('debounce, variant changes while blocked, and focus on return', () => {
    vi.useFakeTimers();
    const tick = (ms: number): void => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };
    const shortfall = (): string | null =>
      document.querySelector('.screen-too-small')?.getAttribute('data-shortfall') ?? null;
    try {
      installViewport(1280, 800);
      signInCashier();
      renderFrame();

      resizeTo(1280, 599);
      tick(99);
      expect(showsScreen()).toBe(true); // still inside the debounce
      tick(2);
      expect(showsScreen()).toBe(false);
      expect(shortfall()).toBe('height');
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));

      // Narrower as well: the variant changes and focus moves to the new heading.
      resizeTo(1023, 599);
      tick(101);
      expect(shortfall()).toBe('both');
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));

      // Back over the width floor only: still blocked, by height.
      resizeTo(1024, 599);
      tick(101);
      expect(shortfall()).toBe('height');
      expect(showsScreen()).toBe(false);

      // Back over both floors in one resize: the screen returns, focus on <main>.
      resizeTo(1024, 600);
      tick(101);
      expect(showsScreen()).toBe(true);
      expect(shortfall()).toBeNull();
      expect(document.activeElement).toBe(frameMain());
      expect(document.activeElement).not.toBe(document.body);
      // Focusable by script, never a Tab stop.
      expect(frameMain()).toHaveAttribute('tabindex', '-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a crossing of both floors in one resize blocks once and returns once', async () => {
    installViewport(1280, 800);
    signInCashier();
    renderFrame();
    resizeTo(1023, 599);
    await settleTier();
    expect(screen.getAllByRole('heading', { level: 1, name: TOO_SMALL })).toHaveLength(1);
    resizeTo(1280, 800);
    await settleTier();
    expect(showsScreen()).toBe(true);
    expect(document.activeElement).toBe(frameMain());
  });

  it.each([
    ['width', 1023, 800],
    ['height', 1280, 599],
    ['both', 1023, 599],
  ] as const)('after the %s notice, focus is never left on <body>', async (_floor, w, h) => {
    installViewport(1280, 800);
    signInCashier();
    renderFrame();
    resizeTo(w, h);
    await settleTier();
    resizeTo(1280, 800);
    await settleTier();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(frameMain());
  });

  it('a screen that focuses its own control on mount keeps that focus on return', async () => {
    function ScanReadyScreen(): JSX.Element {
      const fieldRef = useRef<HTMLInputElement>(null);
      useEffect(() => {
        fieldRef.current?.focus();
      }, []);
      return (
        <section aria-labelledby="screen-title">
          <h1 id="screen-title">مساحة البيع</h1>
          <input ref={fieldRef} aria-label="حقل المسح" />
        </section>
      );
    }
    installViewport(1280, 800);
    signInCashier();
    render(
      <MemoryRouter initialEntries={[V5_SALE_PATH]}>
        <V5Frame>
          <ScanReadyScreen />
        </V5Frame>
      </MemoryRouter>,
    );
    resizeTo(1280, 599);
    await settleTier();
    resizeTo(1280, 800);
    await settleTier();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'حقل المسح' }));
  });
});
