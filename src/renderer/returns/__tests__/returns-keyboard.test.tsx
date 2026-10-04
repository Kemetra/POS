import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type {
  ReturnsLookupResponse,
  ReturnsQuoteResponse,
  ReturnsSubmitResponse,
} from '../../../shared/returns/types.js';
import {
  deferred,
  settle,
  fakeBridge,
  journal,
  lookUpSale,
  pickAndQuote,
  QUOTE,
  renderReturns,
  resetStores,
  SALE,
  SALE_NUMBER,
} from './returns-test-kit.js';

/** RT-15 S3 — D1..D3 and K1, K2: one call at a time; Enter never confirms money. */
afterEach(() => {
  cleanup();
  resetStores();
});

describe('double submit (D1)', () => {
  it('a double click on confirm submits once; the button is busy until main answers', async () => {
    const bridge = fakeBridge();
    const pending = deferred<ReturnsSubmitResponse>();
    bridge.submit.mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    renderReturns({ bridge });
    await lookUpSale(user);
    await pickAndQuote(user);
    const confirm = screen.getByRole('button', { name: 'تأكيد الإرجاع' });
    await user.dblClick(confirm);
    expect(bridge.submit).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'تعديل الكميات' })).toBeDisabled();
    await settle(pending, { kind: 'confirmed', ret: journal(), replayed: false });
    expect(await screen.findByRole('heading', { name: 'نتيجة المرتجع' })).toBeInTheDocument();
  });
});

describe('single-flight lookup and quote (D2)', () => {
  it('repeated Enter looks up once, a double click quotes once', async () => {
    const bridge = fakeBridge();
    const found = deferred<ReturnsLookupResponse>();
    const priced = deferred<ReturnsQuoteResponse>();
    bridge.lookup.mockImplementationOnce(() => found.promise);
    bridge.quote.mockImplementationOnce(() => priced.promise);
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.type(screen.getByLabelText('رقم البيع'), `${SALE_NUMBER}{Enter}{Enter}`);
    expect(bridge.lookup).toHaveBeenCalledTimes(1);
    await settle(found, { kind: 'ok', sale: SALE });
    await user.click(screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' }));
    await user.dblClick(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' }));
    expect(bridge.quote).toHaveBeenCalledTimes(1);
    await settle(priced, { kind: 'ok', quote: QUOTE });
  });
});

describe('Enter never confirms the refund (D3, K2)', () => {
  it('the summary takes focus on its heading, and Enter there submits nothing', async () => {
    const bridge = fakeBridge();
    const user = userEvent.setup();
    renderReturns({ bridge });
    expect(screen.getByLabelText('رقم البيع')).toHaveFocus();
    await lookUpSale(user);
    expect(screen.getByRole('heading', { name: 'اختر الأصناف المرتجعة' })).toHaveFocus();
    await pickAndQuote(user);
    expect(screen.getByRole('heading', { name: 'ملخص الاسترداد' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(bridge.submit).not.toHaveBeenCalled();
  });
});

/** Tab forward (at most 12 stops) until the named button has focus. */
async function tabTo(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  const target = screen.getByRole('button', { name });
  for (let i = 0; i < 12 && document.activeElement !== target; i++) await user.tab();
  expect(target).toHaveFocus();
}

describe('keyboard only (K1)', () => {
  it('runs lookup, pick, quote and confirm with Tab, Space and Enter', async () => {
    const bridge = fakeBridge();
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.keyboard(`${SALE_NUMBER}{Enter}`);
    await screen.findByRole('heading', { name: 'اختر الأصناف المرتجعة' });
    await tabTo(user, 'زيادة بانادول 500 مجم');
    await user.keyboard(' ');
    await tabTo(user, 'احسب مبلغ الاسترداد');
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'ملخص الاسترداد' });
    await tabTo(user, 'تأكيد الإرجاع');
    await user.keyboard(' ');
    expect(await screen.findByRole('heading', { name: 'نتيجة المرتجع' })).toHaveFocus();
    expect(bridge.submit).toHaveBeenCalledTimes(1);
    await tabTo(user, 'مرتجع جديد');
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('رقم البيع')).toHaveFocus();
  });
});
