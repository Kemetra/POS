/**
 * T260 — `<PrinterFailureBanner>` persistence + affordances (RED).
 *
 * Mounts whenever the latest print_events row for a recently-finalized sale is
 * outcome='failure'. Non-modal, does NOT auto-dismiss, includes three
 * affordances (Retry print / Reprint / Manual receipt) each ≥ 44×44 px
 * (NFR-002 / Constitution §IV / FR-068).
 *
 * Red-bar recorded in coordination.md before the T290 /impeccable craft.
 *
 * The component accepts an injected `printFailure` (the projected banner state
 * — test injects it; production receives it via sales.subscribe(banner_state),
 * which is currently the not_implemented stub) and injected bridges (same
 * posture as ReceiptPreview / PaymentSurface).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { PrinterFailureBanner } from '../../../../src/renderer/ui/receipts/PrinterFailureBanner.js';
import type { ReceiptsBridgeAPI } from '../../../../src/shared/bridge-api.js';

const FAILURE = {
  sale_id: 'sale-1',
  failure_reason: 'printer_offline' as const,
  has_successful_print: false,
};

function okReceiptsBridge(): ReceiptsBridgeAPI {
  return {
    preview: vi.fn(),
    retryPrint: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        outcome: 'success' as const,
        print_event_id: 'pe-1',
        purpose: 'retry_after_failure' as const,
        render_path: 'escpos_direct' as const,
        printed_at: '2026-05-27T10:00:09.000Z',
      }),
    ),
  };
}

afterEach(() => {
  cleanup();
});

describe('T260 — PrinterFailureBanner mounts on failure + carries 3 affordances', () => {
  it('renders the Arabic print-failed message when a print failure is present', () => {
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={okReceiptsBridge()}
      />,
    );
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  it('renders nothing when there is no print failure (unmounted, not hidden)', () => {
    const { container } = render(
      <PrinterFailureBanner
        printFailure={null}
        onReprint={() => {}}
        _testReceiptsBridge={okReceiptsBridge()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('exposes Retry, Reprint, and Manual receipt affordances, each ≥ 44×44', () => {
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={okReceiptsBridge()}
      />,
    );
    for (const name of ['إعادة المحاولة', 'نسخة', 'إيصال يدوي']) {
      const btn = screen.getByRole('button', { name });
      expect(btn).toBeInTheDocument();
      // The 44×44 floor is enforced via the shared `.btn--md` size modifier
      // (block-size: 44px in tailwind.css). happy-dom has no layout engine, so
      // assert the class marker rather than computed height.
      expect(btn.className).toMatch(/btn--md/);
    }
  });

  it('has no close-X (cannot be dismissed without resolving the condition)', () => {
    render(
      <PrinterFailureBanner
        printFailure={FAILURE}
        onReprint={() => {}}
        _testReceiptsBridge={okReceiptsBridge()}
      />,
    );
    expect(screen.queryByRole('button', { name: /close|dismiss|إغلاق/i })).toBeNull();
  });
});
