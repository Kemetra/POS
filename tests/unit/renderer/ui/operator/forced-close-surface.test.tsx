import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ForcedCloseSurface } from '../../../../../src/renderer/ui/operator/ForcedCloseSurface.js';

/**
 * 004-operator-session T083 — ForcedCloseSurface read-only summary tests.
 *
 * Verifies:
 *   - Renders cashier_display_name, terminal_label, opened_at,
 *     duration_minutes (the four Wave 4.1 stub fields).
 *   - FR-024 blind-close discipline: MUST NOT render a drawer-count
 *     entry, expected-total display, variance, shortage, overage,
 *     change fund, or any shift financial/KPI field.
 *   - FR-013 minimum-disclosure: MUST NOT render Clerk user IDs,
 *     device IDs, emails, device tokens, PIN state, or branch/tenant IDs.
 *   - Card-stack layout: rows rendered as div elements, not a table.
 */

const SAMPLE_SHIFT = {
  cashier_display_name: 'Nour Al-Hassan',
  terminal_label: 'Terminal 3 — Pharmacy',
  opened_at: '2026-05-12T08:30:00.000Z',
  duration_minutes: 47,
};

afterEach(() => {
  cleanup();
});

describe('ForcedCloseSurface — rendering', () => {
  it.each([
    { title: 'renders cashier display name', text: 'Nour Al-Hassan' },
    { title: 'renders terminal label', text: 'Terminal 3 — Pharmacy' },
    { title: 'renders opened_at timestamp', text: '2026-05-12T08:30:00.000Z' },
  ])('$title', ({ text }) => {
    render(<ForcedCloseSurface {...SAMPLE_SHIFT} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('renders duration_minutes', () => {
    render(<ForcedCloseSurface {...SAMPLE_SHIFT} />);
    expect(screen.getByText(/47/)).toBeInTheDocument();
  });

  it('renders using div card-stack, not a table', () => {
    const { container } = render(<ForcedCloseSurface {...SAMPLE_SHIFT} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('thead')).toBeNull();
    expect(container.querySelector('tbody')).toBeNull();
    expect(container.querySelector('tr')).toBeNull();
    expect(container.querySelector('[data-testid="forced-close-surface"]')).toBeInTheDocument();
  });
});

describe('ForcedCloseSurface — FR-024 blind-close discipline', () => {
  const FINANCIAL_FORBIDDEN = [
    /drawer/i,
    /count/i,
    /expected/i,
    /total/i,
    /variance/i,
    /shortage/i,
    /overage/i,
    /change fund/i,
    /cash in/i,
    /cash out/i,
    /declared/i,
    /float/i,
    /balance/i,
    /revenue/i,
    /sales/i,
    /reporting/i,
    /reconcil/i,
  ];

  FINANCIAL_FORBIDDEN.forEach((pattern) => {
    it(`does not render financial field matching ${String(pattern)}`, () => {
      const { container } = render(<ForcedCloseSurface {...SAMPLE_SHIFT} />);
      expect(container.textContent).not.toMatch(pattern);
    });
  });
});

describe('ForcedCloseSurface — FR-013 minimum-disclosure', () => {
  const IDENTITY_FORBIDDEN = [
    /user_[0-9a-f-]{8,}/i,
    /usr_[0-9a-z]{10,}/i,
    /dev_[0-9a-z]{10,}/i,
    /device_id/i,
    /device_token/i,
    /attestation/i,
    /tenant_id/i,
    /branch_id/i,
    /terminal_id/i,
    /@[a-z0-9.-]+\.[a-z]{2,}/i,
    /pin/i,
    /credential/i,
    /clerk/i,
  ];

  IDENTITY_FORBIDDEN.forEach((pattern) => {
    it(`does not render identity field matching ${String(pattern)}`, () => {
      const { container } = render(<ForcedCloseSurface {...SAMPLE_SHIFT} />);
      expect(container.textContent).not.toMatch(pattern);
    });
  });
});
