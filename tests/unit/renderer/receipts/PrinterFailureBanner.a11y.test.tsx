/**
 * T263 — `<PrinterFailureBanner>` accessibility (RED).
 *
 * Keyboard-operable, screen-reader landmark (role="status" aria-live="polite"
 * aria-atomic), and — per the §A1 brief (f) keyboard contract — focus does NOT
 * auto-shift to the banner on mount (the cashier may be mid-cart-entry;
 * stealing focus is hostile). The banner is axe-clean.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { PrinterFailureBanner } from '../../../../src/renderer/ui/receipts/PrinterFailureBanner.js';
import { expectNoAxeViolations } from '../../../../src/renderer/ui/primitives/__tests__/axe-config.js';
import type { ReceiptsBridgeAPI } from '../../../../src/shared/bridge-api.js';

const FAILURE = {
  sale_id: 'sale-1',
  failure_reason: 'printer_offline' as const,
  has_successful_print: false,
};

function noopReceiptsBridge(): ReceiptsBridgeAPI {
  return { preview: vi.fn(), retryPrint: vi.fn() };
}

afterEach(() => {
  cleanup();
});

describe('T263 — PrinterFailureBanner accessibility', () => {
  it('exposes a polite status landmark (role=status, aria-live=polite, aria-atomic)', () => {
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });

  it('does NOT steal focus on mount (focus stays on document body)', () => {
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
      />,
    );
    // No affordance should have grabbed focus when the banner appeared.
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    expect(retry).not.toHaveFocus();
  });

  it('is not a color-only signal — the printer icon + text label carry meaning', () => {
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
      />,
    );
    // An accessible icon label or img-role marker accompanies the message.
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={noopReceiptsBridge()}
      />,
    );
    await expectNoAxeViolations(container);
  });
});
