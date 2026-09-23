import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { PrinterFailureBanner } from '../PrinterFailureBanner.js';
import { DrawerFailureBanner } from '../DrawerFailureBanner.js';
import type { ReceiptsBridgeAPI } from '../../../../shared/bridge-api.js';

afterEach(cleanup);

describe('022 US4 — operational failure affordances', () => {
  it('keeps print failure persistent and separates retry from eligible reprint', async () => {
    const retryPrint = vi
      .fn()
      .mockResolvedValue({ kind: 'refused', reason: 'printer_unavailable' });
    const reprint = vi.fn();
    render(
      <PrinterFailureBanner
        printFailure={{
          sale_id: 'sale-1',
          failure_reason: 'printer_offline',
          has_successful_print: false,
        }}
        onReprint={reprint}
        _testReceiptsBridge={{ retryPrint } as unknown as ReceiptsBridgeAPI}
        _idempotencyKeyFactory={() => 'key-1'}
      />,
    );

    const banner = screen.getByTestId('printer-failure-banner');
    expect(banner).toHaveClass('v4-row');
    expect(banner).toHaveTextContent('فشل طباعة الإيصال');
    expect(within(banner).getByRole('button', { name: /reprint/i })).toBeDisabled();
    fireEvent.click(within(banner).getByRole('button', { name: /retry print/i }));
    await waitFor(() => {
      expect(retryPrint).toHaveBeenCalledWith({ sale_id: 'sale-1', idempotency_key: 'key-1' });
    });
    expect(banner).toBeInTheDocument();
    expect(reprint).not.toHaveBeenCalled();
  });

  it('keeps drawer failure persistent with its manual recovery action', () => {
    const onManualOverride = vi.fn();
    render(
      <DrawerFailureBanner
        drawerFailure={{ sale_id: 'sale-2', last_successful_open_at: null }}
        onManualOverride={onManualOverride}
        now="2026-09-23T00:00:00.000Z"
      />,
    );

    const banner = screen.getByTestId('drawer-failure-banner');
    expect(banner).toHaveClass('v4-row');
    expect(banner).toHaveTextContent('لم يفتح درج النقود');
    fireEvent.click(within(banner).getByRole('button', { name: /manual receipt/i }));
    expect(onManualOverride).toHaveBeenCalledWith('sale-2');
    expect(banner).toBeInTheDocument();
  });
});
