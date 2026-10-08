/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed bridge spies trigger this rule on expect(...) assertions.
 */
/**
 * T262 — `<PrinterFailureBanner>` affordance gating (RED).
 *
 * Reprint is DISABLED until a successful print exists (AD-10 precondition:
 * contract line 310 — reprint requires ≥1 prior outcome='success' PrintEvent).
 * In the failure state none exists → Reprint disabled. Retry is ALWAYS enabled
 * while in the failure state. Manual override is always enabled while failed.
 *
 * (The §A1 brief (f) prose loosely calls the failure-banner Reprint a "fresh
 * first-print attempt"; the data-model is decisive — see coordination.md S3c
 * preflight #3. T262 encodes the AD-10-consistent behavior.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { PrinterFailureBanner } from '../../../../src/renderer/ui/receipts/PrinterFailureBanner.js';
import type { ReceiptsBridgeAPI } from '../../../../src/shared/bridge-api.js';

function retryBridge(): ReceiptsBridgeAPI {
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
    reprint: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        print_event_id: 'pe-r-1',
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-27T10:00:09.000Z',
        render_path: 'escpos_direct' as const,
      }),
    ),
    manualOverride: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        print_event_id: 'pe-mo-1',
        purpose: 'first_print' as const,
        outcome: 'manual_override' as const,
        overridden_at: '2026-05-27T10:00:11.000Z',
      }),
    ),
  };
}

afterEach(() => {
  cleanup();
});

describe('T262 — affordance gating', () => {
  it('disables Reprint in the failure state (no prior successful print — AD-10)', () => {
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={retryBridge()}
      />,
    );
    expect(screen.getByRole('button', { name: 'نسخة' })).toBeDisabled();
  });

  it('enables Reprint once a successful print exists for the sale', () => {
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: true,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={retryBridge()}
      />,
    );
    expect(screen.getByRole('button', { name: 'نسخة' })).toBeEnabled();
  });

  it('calls onReprint with the sale id when the enabled Reprint button is clicked', async () => {
    // enabled⟹wired (CodeRabbit #281): an enabled Reprint must do something
    // real. onReprint is the Slice-5 entry-point (receipts.reprint TBD),
    // symmetric with onManualOverride.
    const onReprint = vi.fn();
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: true,
        }}
        onReprint={onReprint}
        _testReceiptsBridge={retryBridge()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'نسخة' }));
    expect(onReprint).toHaveBeenCalledWith('sale-1');
  });

  it('Retry is enabled in the failure state and calls receipts.retryPrint on click', async () => {
    const bridge = retryBridge();
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={bridge}
      />,
    );
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    expect(bridge.retryPrint).toHaveBeenCalledWith(expect.objectContaining({ sale_id: 'sale-1' }));
  });

  it('Manual receipt is always enabled while failed and calls receipts.manualOverride (T512)', async () => {
    const bridge = retryBridge();
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={bridge}
      />,
    );
    const manual = screen.getByRole('button', { name: 'إيصال يدوي' });
    expect(manual).toBeEnabled();
    await userEvent.click(manual);
    expect(bridge.manualOverride).toHaveBeenCalledWith(
      expect.objectContaining({ sale_id: 'sale-1' }),
    );
  });

  it('passes a fresh idempotency_key on each Retry (FR-053)', async () => {
    const bridge = retryBridge();
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={bridge}
        _idempotencyKeyFactory={() => 'fixed-key-1'}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    const call = (bridge.retryPrint as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      idempotency_key: string;
    };
    expect(call.idempotency_key).toBe('fixed-key-1');
  });

  it('recovers (no crash, button re-enabled) when retryPrint rejects', async () => {
    const rejecting: ReceiptsBridgeAPI = {
      preview: vi.fn(),
      retryPrint: vi.fn(() => Promise.reject(new Error('ipc boom'))),
    };
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={rejecting}
      />,
    );
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    await userEvent.click(retry);
    // The catch arm clears the in-flight phase → button is interactive again.
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it('recovers (no crash, button re-enabled) when manualOverride rejects (T512 catch arm)', async () => {
    // Symmetric with the retryPrint-rejects case above: handleManualOverride's
    // .catch clears the local in-flight phase so the Manual button is
    // interactive again. The banner stays up (dismissal is the parent's job).
    const rejecting: ReceiptsBridgeAPI = {
      preview: vi.fn(),
      retryPrint: vi.fn(),
      manualOverride: vi.fn(() => Promise.reject(new Error('ipc boom'))),
    };
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={rejecting}
      />,
    );
    const manual = screen.getByRole('button', { name: 'إيصال يدوي' });
    await userEvent.click(manual);
    expect(rejecting.manualOverride).toHaveBeenCalledWith(
      expect.objectContaining({ sale_id: 'sale-1' }),
    );
    await waitFor(() => expect(manual).toBeEnabled());
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  it('locks ALL three actions while one mutation is in flight (single mutation phase, CodeRabbit #294)', async () => {
    // A cashier must not be able to fire two conflicting mutations against the
    // same failed print. Starting either mutation moves the shared phase off
    // `idle`, which disables Retry + Reprint + Manual until it settles.
    // has_successful_print:true so Reprint is otherwise enabled — proving the
    // lock (not the AD-10 gate) is what disables it here.
    let resolveRetry: (r: {
      kind: 'ok';
      outcome: 'success';
      print_event_id: string;
      purpose: 'retry_after_failure';
      render_path: 'escpos_direct';
      printed_at: string;
    }) => void = () => {};
    const bridge: ReceiptsBridgeAPI = {
      preview: vi.fn(),
      retryPrint: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
      ),
      manualOverride: vi.fn(),
    };
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: true,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={bridge}
      />,
    );
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    const reprint = screen.getByRole('button', { name: 'نسخة' });
    const manual = screen.getByRole('button', { name: 'إيصال يدوي' });

    expect(reprint).toBeEnabled(); // enabled before any mutation
    await userEvent.click(retry);

    // Mutation in flight → the shared phase disables all three actions.
    await waitFor(() => expect(retry).toBeDisabled());
    expect(reprint).toBeDisabled();
    expect(manual).toBeDisabled();
    // The lock held: the manual mutation was never fired.
    expect(bridge.manualOverride).not.toHaveBeenCalled();

    // Settle the in-flight retry → all three re-enable.
    resolveRetry({
      kind: 'ok',
      outcome: 'success',
      print_event_id: 'pe-1',
      purpose: 'retry_after_failure',
      render_path: 'escpos_direct',
      printed_at: '2026-05-27T10:00:09.000Z',
    });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(reprint).toBeEnabled();
    expect(manual).toBeEnabled();
  });

  it('Retry is a no-op when no receipts bridge is available (null resolve, no crash)', async () => {
    // No _testReceiptsBridge and no window.api.receipts → resolveReceiptsBridge null.
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={() => {}}
      />,
    );
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    await userEvent.click(retry);
    // No throw; the banner stays up.
    expect(screen.getByText('فشل طباعة الإيصال')).toBeInTheDocument();
  });

  // ── T512 /impeccable polish (2026-05-30) — in-flight action is surfaced ──
  // The shared mutation phase already distinguishes which action is running;
  // the polish pass makes that legible (DESIGN.md §5 + PRODUCT.md Principle 3:
  // the cashier must know the real state). The ACTIVE button gets aria-busy +
  // the .btn__spinner; the other in-flight-disabled buttons do NOT (so the
  // cashier can tell retry-in-flight from manual-override-in-flight).
  it('surfaces aria-busy + spinner on the ACTIVE button only, per action', async () => {
    let resolveManual: (r: {
      kind: 'ok';
      print_event_id: string;
      purpose: 'first_print';
      outcome: 'manual_override';
      overridden_at: string;
    }) => void = () => {};
    const bridge: ReceiptsBridgeAPI = {
      preview: vi.fn(),
      retryPrint: vi.fn(),
      reprint: vi.fn(),
      manualOverride: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveManual = resolve;
          }),
      ),
    };
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: true,
        }}
        onReprint={() => {}}
        _testReceiptsBridge={bridge}
      />,
    );
    const retry = screen.getByRole('button', { name: 'إعادة المحاولة' });
    const manual = screen.getByRole('button', { name: 'إيصال يدوي' });

    // No action in flight → neither button is busy.
    expect(retry).not.toHaveAttribute('aria-busy');
    expect(manual).not.toHaveAttribute('aria-busy');

    await userEvent.click(manual);

    // Manual override is in flight → ONLY the manual button is busy + spins;
    // Retry is disabled (shared lock) but NOT marked busy.
    await waitFor(() => expect(manual).toHaveAttribute('aria-busy', 'true'));
    expect(manual.querySelector('.btn__spinner')).not.toBeNull();
    expect(retry).not.toHaveAttribute('aria-busy');
    expect(retry.querySelector('.btn__spinner')).toBeNull();

    // Settle → busy state clears.
    resolveManual({
      kind: 'ok',
      print_event_id: 'pe-mo-1',
      purpose: 'first_print',
      outcome: 'manual_override',
      overridden_at: '2026-05-27T10:00:11.000Z',
    });
    await waitFor(() => expect(manual).not.toHaveAttribute('aria-busy'));
    expect(manual.querySelector('.btn__spinner')).toBeNull();
  });
});
