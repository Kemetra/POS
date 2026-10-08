/**
 * RT-240 (VNext A4) — cashier copy is Arabic only, and claims nothing unproven.
 *
 * The older sweep (`expectNoEnglishOnlyStrings`) let BILINGUAL strings through,
 * which is how «طريقة الدفع (Payment method)» and «… / Reprint receipt» shipped.
 * This sweep is strict: once left-to-right runs (money, codes, times) and key
 * caps are set aside, no Latin letter may remain in the text, nor in
 * `aria-label`, `title` or `placeholder`. Only the key names Esc and Enter pass.
 * A left-to-right field's placeholder shows a code format, so it counts as
 * left-to-right content; its accessible name must still be Arabic.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { ReceiptsBridgeAPI } from '../../../../shared/bridge-api.js';
import { TopBar } from '../../../shell/regions/TopBar.js';
import { OperatorBadge } from '../../operator/OperatorBadge.js';
import { DrawerNoticeBanner, DrawerNoticeInline } from '../../receipts/DrawerNotice.js';
import { useDrawerNoticeStore } from '../../receipts/drawer-notice-store.js';
import { PrinterFailureBanner } from '../../receipts/PrinterFailureBanner.js';
import { ReprintAffordance } from '../../receipts/ReprintAffordance.js';
import { CashEntry } from '../CashEntry.js';
import { ExternalCardTerminalEntry } from '../ExternalCardTerminalEntry.js';
import { TenderSelection } from '../TenderSelection.js';
import { VoucherEntry } from '../VoucherEntry.js';
import { latinLeaks } from './latin-leaks.js';

afterEach(cleanup);

function sweep(ui: JSX.Element): string[] {
  const { container } = render(ui);
  return latinLeaks(container);
}

const ENVELOPE: PaymentIntentEnvelope = {
  envelope_version: 'v1',
  cart_id: 'cart-1',
  operator_session_id: 's-1',
  owning_operator_id: 'op-1',
  tenant_id: 't-1',
  branch_id: 'b-1',
  terminal_id: 'term-1',
  lines: [],
  discount_placeholders: [],
  subtotal_minor: 1500,
  created_at: '2026-10-07T09:00:00.000Z',
  handoff_action_id: 'h-1',
};

describe('RT-240 — Checkout surfaces are Arabic only', () => {
  it.each([true, false])('tender selection (voucher tile enabled: %s)', (voucherEnabled) => {
    expect(
      sweep(
        <TenderSelection
          envelope={ENVELOPE}
          selectedTender={null}
          voucherEnabled={voucherEnabled}
          onTenderSelect={vi.fn()}
        />,
      ),
    ).toEqual([]);
  });

  it('cash entry, including the change row', () => {
    const { container } = render(<CashEntry remainingBalanceMinor={1500} onConfirm={vi.fn()} />);
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value: '20' } });
    expect(screen.getByTestId('cash-entry-change-due')).toBeInTheDocument();
    expect(latinLeaks(container)).toEqual([]);
  });

  it('card entry', () => {
    expect(sweep(<ExternalCardTerminalEntry remainingBalanceMinor={1500} />)).toEqual([]);
  });

  it('a left-to-right field never mixes Arabic into its placeholder (bidi garbles it)', () => {
    for (const ui of [
      <ExternalCardTerminalEntry key="card" remainingBalanceMinor={1500} />,
      <VoucherEntry
        key="voucher"
        remainingBalanceMinor={1500}
        paymentAttemptId="pa-1"
        tenderApply={vi.fn()}
      />,
      <CashEntry key="cash" remainingBalanceMinor={1500} onConfirm={vi.fn()} />,
    ]) {
      const { container, unmount } = render(ui);
      for (const field of Array.from(container.querySelectorAll('input[dir="ltr"][placeholder]'))) {
        expect(field.getAttribute('placeholder')).not.toMatch(/[؀-ۿ]/);
      }
      unmount();
    }
  });

  it.each(['cashier', 'manager', 'admin'] as const)(
    'the operator badge in the Checkout header names the role in Arabic (%s)',
    (role) => {
      // An Arabic display name, so any Latin word left is the badge's own copy.
      const { container } = render(<OperatorBadge display_name="د. سارة" role={role} />);
      expect(latinLeaks(container)).toEqual([]);
    },
  );

  it('card entry waiting line is catalog M-P6', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={1500} />);
    expect(
      screen.getByText('أكمل العملية على جهاز البطاقات، ثم سجّل النتيجة.'),
    ).toBeInTheDocument();
  });

  it('voucher entry, idle and while applying', async () => {
    const pending = new Promise<never>(() => undefined);
    const { container } = render(
      <VoucherEntry
        remainingBalanceMinor={1500}
        paymentAttemptId="pa-1"
        tenderApply={vi.fn(() => pending)}
      />,
    );
    expect(latinLeaks(container)).toEqual([]);
    fireEvent.change(screen.getByTestId('voucher-entry-code-input'), {
      target: { value: 'VCH-123' },
    });
    fireEvent.change(screen.getByTestId('voucher-entry-amount-input'), {
      target: { value: '15.00' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('voucher-entry-confirm'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('voucher-entry-applying')).toBeInTheDocument();
    expect(latinLeaks(container)).toEqual([]);
  });
});

describe('RT-240 — payment banners are Arabic only', () => {
  it('printer failure banner, reprint not yet available', () => {
    expect(
      sweep(
        <PrinterFailureBanner
          printFailure={{
            sale_id: 'sale-1',
            failure_reason: 'printer_offline',
            has_successful_print: false,
          }}
          onReprint={vi.fn()}
          _testReceiptsBridge={{ retryPrint: vi.fn() } as unknown as ReceiptsBridgeAPI}
          _idempotencyKeyFactory={() => 'k'}
        />,
      ),
    ).toEqual([]);
  });

  it('drawer notice, status area and completion (RT-241 D-B1)', () => {
    const notice = useDrawerNoticeStore.getState();
    notice.reset();
    notice.observe(null);
    notice.observe({ sale_id: 'sale-2', last_successful_open_at: null });
    try {
      expect(
        sweep(
          <>
            <DrawerNoticeBanner onManualOverride={vi.fn()} now="2026-10-07T00:00:00.000Z" />
            <DrawerNoticeInline />
          </>,
        ),
      ).toEqual([]);
    } finally {
      notice.reset();
    }
  });

  it('reprint affordance, idle, reprinting and refused', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const reprint = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { container } = render(
      <ReprintAffordance
        sale={{ sale_id: 'sale-1', has_successful_print: true }}
        _testReceiptsBridge={{ reprint } as unknown as ReceiptsBridgeAPI}
      />,
    );
    expect(latinLeaks(container)).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(latinLeaks(container)).toEqual([]);
    await act(async () => {
      settle({ kind: 'refused', reason: 'printer_unavailable' });
      await Promise.resolve();
    });
    expect(latinLeaks(container)).toEqual([]);
  });
});

describe('RT-240 — no fabricated connection or theme claims (I-7)', () => {
  it('the shell top bar shows no «Online» pill and no «Dark» toggle', () => {
    render(<TopBar tenantId="t" branchId="b" terminalLabel="T1" connectionState="online" />);
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Dark|Light)$/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-connection-state]')).toBeNull();
  });
});
