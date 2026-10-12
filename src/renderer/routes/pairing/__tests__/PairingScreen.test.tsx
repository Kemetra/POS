import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { PairingScreen } from '../PairingScreen';
import { PAIRING_COPY } from '../../../v5/entry/entry-copy';
import type { PairingBridgeAPI } from '../../../../shared/bridge-api';

/**
 * 002-terminal-pairing T030 — `PairingScreen` tests.
 *
 * The screen hosts `PairingForm` and preserves the US1 surface
 * (data-testid="route-pairing", optional data-invalid-reason for US7).
 * The screen MUST NOT add any other input element on the route — the
 * form's single input is the only input the operator/scanner sees.
 */

function makeBridge(): PairingBridgeAPI {
  return {
    getStatus: vi.fn(() => Promise.reject(new Error('PairingScreen must not call getStatus'))),
    submit: vi.fn(() =>
      Promise.resolve({
        outcome: 'success',
        tenant_id: 't',
        branch_id: 'b',
        terminal_id: 'term',
        terminal_label: 'Counter',
      } as const),
    ),
  };
}

afterEach(() => {
  cleanup();
});

describe('PairingScreen — composition (T030)', () => {
  it('renders inside the route-pairing test scope', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('route-pairing')).toBeInTheDocument();
  });

  it('renders the PairingForm (input + submit button visible)', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('autofocuses the input on mount', async () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
  });

  it('contains exactly one input element on the route', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} />
      </MemoryRouter>,
    );
    // Only the form's pairing-code input is allowed. A future US3+ change
    // adding any second input on the route MUST break this test.
    const inputs = document.querySelectorAll('input');
    expect(inputs).toHaveLength(1);
  });

  it('preserves data-invalid-reason when invalidReason prop is set (US7 compatibility)', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} invalidReason="missing_token" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('route-pairing')).toHaveAttribute(
      'data-invalid-reason',
      'missing_token',
    );
  });

  it('does NOT set data-invalid-reason when invalidReason prop is omitted', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('route-pairing')).not.toHaveAttribute('data-invalid-reason');
  });

  it('falls back to window.api when no `pairing` prop is provided (production path)', () => {
    const fakeApi = {
      ping: vi.fn(),
      appVersion: vi.fn(),
      log: vi.fn(),
      appConfig: vi.fn(),
      pairing: {
        getStatus: vi.fn(() => Promise.reject(new Error('not used'))),
        submit: vi.fn(),
      },
    };
    const original = (window as unknown as { api?: unknown }).api;
    (window as unknown as { api: typeof fakeApi }).api = fakeApi;
    try {
      render(
        <MemoryRouter initialEntries={['/pairing']}>
          {/* No pairing prop — Screen renders form without forwarding,
              form falls back to window.api. */}
          <PairingScreen />
        </MemoryRouter>,
      );
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    } finally {
      if (original === undefined) delete (window as unknown as { api?: unknown }).api;
      else (window as unknown as { api?: unknown }).api = original;
    }
  });

  it('forwards the bridge prop down to the PairingForm (no re-reading window.api)', () => {
    // Regression guard: the screen MUST pass the injected bridge to the
    // form. If the form falls through to window.api when the screen
    // received a bridge prop, this test fails.
    const bridge = makeBridge();
    // Deliberately do NOT set window.api — if the form tries to read
    // it, the form throws "window.api missing".
    const original = (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { api?: unknown }).api;
    try {
      render(
        <MemoryRouter initialEntries={['/pairing']}>
          <PairingScreen pairing={bridge} />
        </MemoryRouter>,
      );
      // The form rendered without throwing — it received the prop.
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    } finally {
      if (original !== undefined) (window as unknown as { api?: unknown }).api = original;
    }
  });
});

/**
 * T069 (US7) — InvalidStateBanner rendered by PairingScreen.
 *
 * Each `invalid` reason maps to a specific user-facing message. The
 * banner MUST use role="alert" (for screen-reader announcement) and
 * MUST contain zero <input> elements (the existing T030 input-count
 * test must remain passing at exactly 1 input on the route).
 */
describe('PairingScreen — InvalidStateBanner (T069)', () => {
  it('renders the missing_token banner message when reason is "missing_token"', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} invalidReason="missing_token" />
      </MemoryRouter>,
    );
    expect(screen.getByText('يجب ربط الجهاز مرة أخرى. مفتاح الأمان مفقود.')).toBeInTheDocument();
  });

  it('renders the orphaned_row banner message when reason is "orphaned_row"', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} invalidReason="orphaned_row" />
      </MemoryRouter>,
    );
    expect(
      screen.getByText('يجب ربط الجهاز مرة أخرى. بيانات الربط المحفوظة ناقصة.'),
    ).toBeInTheDocument();
  });

  it('renders the decrypt_failed banner message when reason is "decrypt_failed"', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} invalidReason="decrypt_failed" />
      </MemoryRouter>,
    );
    expect(
      screen.getByText('يجب ربط الجهاز مرة أخرى. تعذّر استرجاع مفتاح الأمان.'),
    ).toBeInTheDocument();
  });

  it('does NOT render any banner when invalidReason is omitted', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('banner has role="alert" (screen-reader announcement)', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} invalidReason="missing_token" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('banner contains zero input elements (T030 input-count invariant preserved)', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} invalidReason="missing_token" />
      </MemoryRouter>,
    );
    // The total on the route must still be exactly 1 (form's pairing-code input).
    const inputs = document.querySelectorAll('input');
    expect(inputs).toHaveLength(1);
  });
});

describe('PairingScreen — the G-1 pairing card (RT-244 PR2)', () => {
  function renderScreen(invalidReason?: 'device_revoked'): void {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        {invalidReason !== undefined ? (
          <PairingScreen pairing={makeBridge()} invalidReason={invalidReason} />
        ) : (
          <PairingScreen pairing={makeBridge()} />
        )}
      </MemoryRouter>,
    );
  }

  it('is an Arabic RTL card whose heading names the form', () => {
    renderScreen();
    const root = screen.getByTestId('route-pairing');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(root).toHaveAttribute('lang', 'ar');
    expect(screen.getByRole('heading', { level: 1, name: PAIRING_COPY.title })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: PAIRING_COPY.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PAIRING_COPY.submit })).toBeInTheDocument();
  });

  it('the code field is LTR, labelled, and described by the hint and the status slot', () => {
    renderScreen();
    const input = screen.getByRole('textbox', { name: PAIRING_COPY.field });
    expect(input).toHaveAttribute('dir', 'ltr');
    expect(input).toHaveAccessibleDescription(expect.stringContaining(PAIRING_COPY.hint));
    // The live region is mounted before the first message, so it is announced.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(
      screen.getByRole('status').id,
    );
  });

  it('shows the revoked notice in Arabic, keeping the unsent-sales guarantee', () => {
    renderScreen('device_revoked');
    const banner = screen.getByTestId('invalid-state-banner');
    expect(banner).toHaveAttribute('data-tone', 'warning');
    // RT-24 / RT-138 L6: the operator is told unsent sales stay on the terminal.
    expect(banner).toHaveTextContent('المبيعات التي لم تُرسَل محفوظة على الجهاز.');
    expect(document.querySelector('[data-testid="route-pairing"] [lang="en"]')).toBeNull();
  });
});

describe('PairingScreen — the inconsistent-pairing notice (RT-306, RT-244 copy)', () => {
  it('says the last pairing did not finish', () => {
    render(
      <MemoryRouter initialEntries={['/pairing']}>
        <PairingScreen pairing={makeBridge()} invalidReason="inconsistent" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('invalid-state-banner')).toHaveTextContent(
      'يجب ربط الجهاز مرة أخرى. آخر عملية ربط لم تكتمل.',
    );
  });
});
