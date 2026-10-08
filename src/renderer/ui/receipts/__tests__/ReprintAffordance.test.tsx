import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ReprintAffordance } from '../ReprintAffordance';
import type { ReceiptsBridgeAPI, ReceiptsReprintResponse } from '../../../../shared/bridge-api.js';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

/**
 * Phase 5 (POS v3.5) — `<ReprintAffordance>` brought under the coverage net as
 * it sits in the find-sale → reprint chain the preview wiring touches. Pins the
 * AD-10 visibility gate + the two-way reprint outcome handling.
 */

function okReprintBridge(): ReceiptsBridgeAPI {
  const res: ReceiptsReprintResponse = { kind: 'ok' } as ReceiptsReprintResponse;
  return { reprint: vi.fn().mockResolvedValue(res) } as unknown as ReceiptsBridgeAPI;
}

function refusedReprintBridge(): ReceiptsBridgeAPI {
  const res = {
    kind: 'refused',
    reason: 'printer_unavailable',
  } as unknown as ReceiptsReprintResponse;
  return { reprint: vi.fn().mockResolvedValue(res) } as unknown as ReceiptsBridgeAPI;
}

function throwingReprintBridge(): ReceiptsBridgeAPI {
  return { reprint: vi.fn().mockRejectedValue(new Error('ipc')) } as unknown as ReceiptsBridgeAPI;
}

const printedSale = { sale_id: 'sale-1', has_successful_print: true };
const unprintedSale = { sale_id: 'sale-2', has_successful_print: false };

describe('ReprintAffordance (Phase 5 chain coverage)', () => {
  it('renders nothing when the sale has no successful print (AD-10)', () => {
    const { container } = render(<ReprintAffordance sale={unprintedSale} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the reprint button when a successful print exists', () => {
    render(<ReprintAffordance sale={printedSale} _testReceiptsBridge={okReprintBridge()} />);
    expect(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' })).toBeInTheDocument();
  });

  it('calls receipts.reprint with the sale id and a fresh idempotency key', async () => {
    const reprint = vi.fn().mockResolvedValue({ kind: 'ok' });
    const bridge = { reprint } as unknown as ReceiptsBridgeAPI;
    const keyFactory = vi.fn(() => 'fixed-key');
    render(
      <ReprintAffordance
        sale={printedSale}
        _testReceiptsBridge={bridge}
        _idempotencyKeyFactory={keyFactory}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' }));
    await waitFor(() => {
      expect(reprint).toHaveBeenCalledWith({
        sale_id: 'sale-1',
        idempotency_key: 'fixed-key',
      });
    });
  });

  it('surfaces an inline failure when the reprint is refused', async () => {
    render(<ReprintAffordance sale={printedSale} _testReceiptsBridge={refusedReprintBridge()} />);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/تعذّرت إعادة طباعة الإيصال/);
  });

  it('surfaces an inline failure when the reprint IPC rejects', async () => {
    render(<ReprintAffordance sale={printedSale} _testReceiptsBridge={throwingReprintBridge()} />);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('no-ops when no receipts bridge is available', () => {
    // No injected bridge, no window.api → resolveReceiptsBridge null → early return.
    render(<ReprintAffordance sale={printedSale} />);
    const btn = screen.getByRole('button', { name: 'إعادة طباعة الإيصال' });
    fireEvent.click(btn);
    // No crash, no feedback row.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses the default crypto key factory when none is injected', async () => {
    const bridge = okReprintBridge();
    const uuid = vi.fn(() => '11111111-1111-4111-8111-111111111111');
    vi.stubGlobal('crypto', { randomUUID: uuid });
    render(<ReprintAffordance sale={printedSale} _testReceiptsBridge={bridge} />);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' }));
    await waitFor(() => {
      expect(uuid).toHaveBeenCalled();
    });
  });
});
