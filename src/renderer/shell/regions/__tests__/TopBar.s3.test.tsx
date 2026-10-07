/**
 * T057 [S3] — TopBar S3 restyle assertions.
 *
 * Covers:
 * - POS Pulse wordmark present in left cluster
 * - Left cluster (.top-bar__left) and right cluster (.top-bar__right)
 * - IdentityStrip inside left cluster
 * - OperatorSlot in right cluster; no connection pill (RT-240, I-7)
 * - StatusBanner outside <header> for non-online states
 * - No device token, no sensitive identifiers in rendered DOM
 * - axe baseline smoke across all connection states
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { TopBar } from '../TopBar';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';
import type { ConnectionState } from '../../../ui/tokens/connection-state';

afterEach(cleanup);

function renderTopBar(connectionState: ConnectionState = 'online') {
  return render(
    <MemoryRouter>
      <TopBar
        tenantId="Acme Pharmacy"
        branchId="Main St"
        terminalLabel="Counter 1"
        connectionState={connectionState}
      />
    </MemoryRouter>,
  );
}

describe('TopBar S3 restyle (T057)', () => {
  it('renders POS Pulse wordmark in left cluster', () => {
    const { container } = renderTopBar();
    const left = container.querySelector('.top-bar__left');
    expect(left).toBeInTheDocument();
    expect(left?.querySelector('.top-bar__wordmark')).toBeInTheDocument();
    expect(screen.getByText('POS Pulse')).toBeInTheDocument();
  });

  it('renders IdentityStrip inside left cluster', () => {
    const { container } = renderTopBar();
    const left = container.querySelector('.top-bar__left');
    const strip = left?.querySelector('.identity-strip');
    expect(strip).toBeInTheDocument();
  });

  // RT-240 (I-7): nothing measures the connection, so the bar claims nothing.
  it.each(['online', 'degraded', 'offline', 'syncing'] as const)(
    'renders no connection pill (state %s)',
    (state) => {
      const { container } = renderTopBar(state);
      expect(container.querySelector('[data-connection-state]')).toBeNull();
      expect(container.textContent).not.toMatch(/Online|Offline|Syncing|Degraded/);
    },
  );

  it('renders OperatorSlot inside right cluster', () => {
    const { container } = renderTopBar();
    const right = container.querySelector('.top-bar__right');
    const slot = right?.querySelector('.operator-slot');
    expect(slot).toBeInTheDocument();
  });

  it('StatusBanner is rendered outside <header> when connection is non-online', () => {
    const { container } = renderTopBar('degraded');
    const header = container.querySelector('header[role="banner"]');
    // Banner is rendered as a sibling, not inside the header
    const bannerInsideHeader = header?.querySelector('[data-state]');
    expect(bannerInsideHeader).not.toBeInTheDocument();
    // But banner exists in the overall DOM
    expect(container.querySelector('[data-state="degraded"]')).toBeInTheDocument();
  });

  it('connection banner copy is Arabic-first (POS v3.5)', () => {
    // degraded → amber «الاتصال بطيء» (Arabic only, RT-240)
    expect(renderTopBar('degraded').container.textContent).toContain('الاتصال بطيء');
    expect(renderTopBar('degraded').container.textContent).not.toContain('Connection slow');
    cleanup();
    // offline → red "غير متصل — البيع من قائمة الانتظار المحلية"
    expect(renderTopBar('offline').container.textContent).toContain(
      'غير متصل — البيع من قائمة الانتظار المحلية',
    );
    cleanup();
    // syncing → teal "جارٍ المزامنة…"
    expect(renderTopBar('syncing').container.textContent).toContain('جارٍ المزامنة…');
  });

  it('no device_token visible in DOM', () => {
    const { container } = renderTopBar();
    const text = container.textContent;
    expect(text).not.toMatch(/device_token/i);
    expect(text).not.toMatch(/tok_/);
  });

  it('wordmark has accessible label', () => {
    renderTopBar();
    const wordmark = screen.getByLabelText('POS Pulse');
    expect(wordmark).toBeInTheDocument();
  });

  it.each(['online', 'degraded', 'offline', 'syncing'] as ConnectionState[])(
    'no axe violations for connection state=%s',
    async (state) => {
      const { container } = renderTopBar(state);
      await expectNoAxeViolations(container);
    },
  );
});
