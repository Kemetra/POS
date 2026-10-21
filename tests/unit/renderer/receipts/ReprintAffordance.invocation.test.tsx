/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed bridge spies trigger this rule on expect(...) assertions.
 */
/**
 * T431 — `<ReprintAffordance>` invocation (RED).
 *
 *   - Clicking Reprint calls receipts.reprint with the sale id + a fresh
 *     idempotency key per click (FR-068 touch target ≥ 44×44; FR-069 keyboard).
 *   - Each click generates a NEW idempotency key.
 *   - The button is keyboard-operable.
 *   - A refusal / rejection does not crash; the button re-enables.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ReprintAffordance } from '../../../../src/renderer/v5/manager/sales/ReprintAffordance.js';
import type { ReceiptsBridgeAPI } from '../../../../src/shared/bridge-api.js';

function okBridge(): ReceiptsBridgeAPI {
  return {
    preview: vi.fn(),
    retryPrint: vi.fn(),
    reprint: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        print_event_id: 'pe-reprint-1',
        duplicate_copy_sequence_number: 1,
        reprinted_at: '2026-05-27T10:00:09.000Z',
        render_path: 'escpos_direct' as const,
      }),
    ),
  };
}

afterEach(() => {
  cleanup();
});

describe('T431 — ReprintAffordance invocation', () => {
  it('calls receipts.reprint with the sale id on click', async () => {
    const bridge = okBridge();
    render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: true }}
        _testReceiptsBridge={bridge}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' }));
    expect(bridge.reprint).toHaveBeenCalledWith(expect.objectContaining({ sale_id: 'sale-1' }));
  });

  it('passes a fresh idempotency_key on each click', async () => {
    const bridge = okBridge();
    let n = 0;
    render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: true }}
        _testReceiptsBridge={bridge}
        _idempotencyKeyFactory={() => `key-${String(++n)}`}
      />,
    );
    const button = screen.getByRole('button', { name: 'إعادة طباعة الإيصال' });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    const calls = (bridge.reprint as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ idempotency_key: string }]
    >;
    expect(calls[0][0].idempotency_key).toBe('key-1');
    expect(calls[1][0].idempotency_key).toBe('key-2');
  });

  it('is keyboard-operable (Enter triggers reprint)', async () => {
    const bridge = okBridge();
    render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: true }}
        _testReceiptsBridge={bridge}
      />,
    );
    const button = screen.getByRole('button', { name: 'إعادة طباعة الإيصال' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(bridge.reprint).toHaveBeenCalledWith(expect.objectContaining({ sale_id: 'sale-1' }));
  });

  it('the button meets the 44x44 touch-target floor', () => {
    render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: true }}
        _testReceiptsBridge={okBridge()}
      />,
    );
    const button = screen.getByRole('button', { name: 'إعادة طباعة الإيصال' });
    // The shared v5 button class encodes the 44px floor (FR-068); jsdom cannot lay it
    // out, so assert the class and that the button system declares the floor on it.
    expect(button).toHaveClass('v5-sales-btn', 'v5-btn');
    const css = readFileSync(
      resolve(__dirname, '../../../../src/renderer/v5/foundation/buttons.css'),
      'utf-8',
    );
    const rule = /\.v5-btn\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/min-block-size:\s*44px/);
    expect(rule).toMatch(/min-inline-size:\s*44px/);
  });

  it('recovers (no crash, button re-enabled) when reprint rejects', async () => {
    const rejecting: ReceiptsBridgeAPI = {
      preview: vi.fn(),
      retryPrint: vi.fn(),
      reprint: vi.fn(() => Promise.reject(new Error('ipc boom'))),
    };
    render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: true }}
        _testReceiptsBridge={rejecting}
      />,
    );
    const button = screen.getByRole('button', { name: 'إعادة طباعة الإيصال' });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('is a no-op (no crash) when no receipts bridge is available', async () => {
    render(<ReprintAffordance sale={{ sale_id: 'sale-1', has_successful_print: true }} />);
    const button = screen.getByRole('button', { name: 'إعادة طباعة الإيصال' });
    await userEvent.click(button);
    expect(button).toBeInTheDocument();
  });
});
