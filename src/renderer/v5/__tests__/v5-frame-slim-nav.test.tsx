/**
 * RT-242 (VNext W1-B / VN-S12) — the frame's slim navigation rail on an
 * active-sale route. Owner decision (RT-242 session, 2026-10-09): route-based —
 * slim on the Sale and Checkout routes, the labelled panel everywhere else.
 * DESIGN.md "Frame — Direction B": slim rail ≈76px, icon + short label; labels
 * stay visible (operators are workflow experts, not icon readers).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '../../../shared/operator/role';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { expectNoAxeViolations } from '../../ui/primitives/__tests__/axe-config';
import { V5Frame } from '../frame/V5Frame';
import { isActiveSaleRoute } from '../frame/nav-model';

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

function renderAt(path: string): HTMLElement {
  render(
    <MemoryRouter initialEntries={[path]}>
      <V5Frame>
        <section aria-labelledby="t">
          <h1 id="t">شاشة</h1>
        </section>
      </V5Frame>
    </MemoryRouter>,
  );
  return screen.getByTestId('v5-frame');
}

describe('isActiveSaleRoute', () => {
  it.each([
    ['/app/cart', true],
    ['/app/checkout', true],
    ['/app/checkout/complete', true],
    ['/app/dashboard', false],
    ['/app/sales', false],
    ['/app/shift', false],
    ['/app/cartography', false],
  ])('%s → %s', (path, expected) => {
    expect(isActiveSaleRoute(path)).toBe(expected);
  });
});

describe('the frame nav on an active-sale route', () => {
  it.each(['/app/cart', '/app/checkout'])('is the slim rail on %s', (path) => {
    signIn('manager');
    expect(renderAt(path)).toHaveAttribute('data-nav', 'slim');
  });

  it.each(['/app/dashboard', '/app/sales'])('is the labelled panel on %s', (path) => {
    signIn('manager');
    expect(renderAt(path)).toHaveAttribute('data-nav', 'panel');
  });

  it('keeps every visible label as the accessible name in the slim rail', () => {
    signIn('manager');
    renderAt('/app/cart');
    const nav = screen.getByRole('navigation', { name: 'التنقل الرئيسي' });
    for (const name of ['لوحة المتابعة', 'نقطة البيع', 'المبيعات', 'المرتجعات', 'الإعدادات']) {
      expect(within(nav).getByRole('link', { name })).toHaveTextContent(name);
    }
    expect(within(nav).getByRole('link', { name: 'نقطة البيع' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('draws a decorative icon beside each label, hidden from assistive tech', () => {
    signIn('manager');
    renderAt('/app/cart');
    const link = screen.getByRole('link', { name: 'المبيعات' });
    const icon = link.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the operator and sign-out in the slim rail', () => {
    signIn('cashier');
    renderAt('/app/cart');
    expect(screen.getByTestId('v5-frame-operator')).toHaveTextContent('د. سارة');
    expect(screen.getByRole('button', { name: 'تسجيل الخروج' })).toBeInTheDocument();
  });

  it('is axe-clean in the slim rail', async () => {
    signIn('manager');
    await expectNoAxeViolations(renderAt('/app/cart'));
  });
});

describe('slim rail CSS', () => {
  const css = readFileSync(resolve(__dirname, '../frame/frame.css'), 'utf8');

  it('narrows the nav track to about 76px only for data-nav="slim"', () => {
    expect(css).toMatch(/\.v5-frame\[data-nav='slim'\]\s*\{[^}]*--v5-nav-inline-size:\s*76px/);
  });

  // DESIGN.md "The Twelve-Pixel Rule": nothing a cashier reads is below 12px;
  // 11px (--font-size-2xs) is for keyboard-hint chips only.
  it('never sets slim-rail text below 12px', () => {
    const slimRules = [...css.matchAll(/\.v5-frame\[data-nav='slim'\][^{]*\{([^}]*)\}/g)];
    expect(slimRules.length).toBeGreaterThan(0);
    for (const [, body] of slimRules) expect(body).not.toMatch(/--font-size-2xs/);
  });

  it('keeps the link target floor in the slim rail', () => {
    const rule = /\.v5-frame\[data-nav='slim'\] \.v5-frame__link\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    for (const match of (rule?.[1] ?? '').matchAll(/min-block-size:\s*(\d+)px/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(44);
    }
  });
});
