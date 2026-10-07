/**
 * T430 — `<ReprintAffordance>` gating (RED).
 *
 * The reprint affordance is visible ONLY when the sale has at least one prior
 * successful PrintEvent (AD-10 precondition). When no successful print exists,
 * the component renders nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ReprintAffordance } from '../../../../src/renderer/ui/receipts/ReprintAffordance.js';
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

describe('T430 — ReprintAffordance gating', () => {
  it('renders nothing when no successful print exists', () => {
    const { container } = render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: false }}
        _testReceiptsBridge={okBridge()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'إعادة طباعة الإيصال' })).not.toBeInTheDocument();
  });

  it('renders the Reprint button when a successful print exists', () => {
    render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: true }}
        _testReceiptsBridge={okBridge()}
      />,
    );
    expect(screen.getByRole('button', { name: 'إعادة طباعة الإيصال' })).toBeInTheDocument();
  });
});
