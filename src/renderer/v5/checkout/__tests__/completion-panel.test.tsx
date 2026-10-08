/**
 * RT-243 W1-C (freeze 15 S14, A4) — the completion panel lists only proven
 * facts: payment taken (success), main's change to hand back (M-P5), and the
 * receipt as not issued (info) or never issued (warning). It never claims a
 * print, a sale number, a completed sale or sync, and «بيع جديد» owns focus
 * without letting the Enter that settled the payment fall through onto it.
 */

import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompletionPanel, type CompletionPanelProps } from '../CompletionPanel';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config.js';

const IDS = {
  root: 'root',
  panel: 'panel',
  proofs: 'proofs',
  amount: 'amount',
  change: 'change',
  cardVoid: 'card-void',
  newSale: 'new-sale',
} as const;

const CARD_VOID = 'أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.';

function renderPanel(overrides: Partial<CompletionPanelProps> = {}): {
  onNewSale: ReturnType<typeof vi.fn>;
} {
  const onNewSale = vi.fn();
  render(
    <CompletionPanel
      paidMinor={99_225}
      changeDueMinor={0}
      saleFinalization
      cardVoidCopy={null}
      drawerNotice={null}
      operator={<span>أحمد</span>}
      onNewSale={onNewSale}
      testIds={IDS}
      {...overrides}
    />,
  );
  return { onNewSale };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RT-243 completion — proof list shows only proven facts', () => {
  it('marks the payment as the one proven success, with the amount isolated LTR', () => {
    renderPanel();
    const payment = screen.getByTestId('completion-proof-payment');
    expect(payment).toHaveAttribute('data-tone', 'success');
    expect(payment).toHaveTextContent('تم استلام المبلغ');
    const amount = screen.getByTestId(IDS.amount);
    expect(amount.tagName).toBe('BDI');
    expect(amount).toHaveAttribute('dir', 'ltr');
    expect(amount).toHaveTextContent('992.25 EGP');
    // FR-16: the settled amount stays the dominant figure even with no change.
    expect(payment).toHaveAttribute('data-emphasis', 'true');

    // Every other line is not a success: success is for proven facts only.
    const lines = within(screen.getByTestId(IDS.proofs)).getAllByRole('listitem');
    expect(lines.filter((l) => l.getAttribute('data-tone') === 'success')).toHaveLength(1);
  });

  it('says no receipt has issued yet (info) while finalization is on', () => {
    renderPanel();
    const receipt = screen.getByTestId('completion-proof-receipt');
    expect(receipt).toHaveAttribute('data-tone', 'info');
    expect(receipt).toHaveTextContent('لم يصدر إيصال بعد.');
  });

  it('says no record or receipt will exist (warning) when finalization is off', () => {
    renderPanel({ saleFinalization: false });
    const receipt = screen.getByTestId('completion-proof-receipt');
    expect(receipt).toHaveAttribute('data-tone', 'warning');
    expect(receipt).toHaveTextContent('لن يُسجَّل هذا البيع ولا يوجد إيصال له.');
    expect(receipt.textContent).not.toMatch(/جارٍ|يجري/u);
  });

  it('claims no print, no receipt sent, no completed sale, no sale number and no sync', () => {
    renderPanel({ changeDueMinor: 775 });
    const root = screen.getByTestId(IDS.root);
    // N-09 / M-C2: «طُبع» and «أُرسل الإيصال» need proof tied to this sale.
    expect(root.textContent).not.toMatch(/طُبع|طبع|أُرسل|أرسل/u);
    // M-C1 «اكتمل البيع» and «رقم البيع» wait on D-N1 / a correlating id.
    expect(root.textContent).not.toMatch(/اكتمل البيع|رقم البيع/u);
    // Sync health is shown only from a real signal; there is none here.
    expect(root.textContent).not.toMatch(/مزامن|تمت المزامنة|متصل/u);
    expect(within(root).queryAllByRole('listitem')).toHaveLength(3);
  });

  it('is announced politely, never as an alert', () => {
    renderPanel();
    const proofs = screen.getByTestId(IDS.proofs);
    expect(proofs).toHaveAttribute('role', 'status');
    expect(proofs).toHaveAttribute('aria-live', 'polite');
  });
});

describe('RT-243 completion — change to hand back (M-P5)', () => {
  it("shows main's change, large and neutral, as an LTR run", () => {
    renderPanel({ changeDueMinor: 125_000 });
    const change = screen.getByTestId(IDS.change);
    expect(change).toHaveTextContent('الباقي للعميل');
    expect(change).toHaveAttribute('data-tone', 'neutral');
    expect(change).toHaveAttribute('data-emphasis', 'true');
    expect(within(change).getByText('1,250.00 EGP')).toHaveAttribute('dir', 'ltr');
  });

  it.each([0, -100, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'shows no change line for %s rather than a misleading value',
    (changeDueMinor) => {
      renderPanel({ changeDueMinor });
      expect(screen.queryByTestId(IDS.change)).not.toBeInTheDocument();
    },
  );

  it('lists the change right after the payment, before the receipt', () => {
    renderPanel({ changeDueMinor: 775 });
    const ids = within(screen.getByTestId(IDS.proofs))
      .getAllByRole('listitem')
      .map((l) => l.getAttribute('data-testid'));
    expect(ids).toEqual(['completion-proof-payment', IDS.change, 'completion-proof-receipt']);
  });
});

describe('RT-243 completion — card void and drawer slots', () => {
  it('shows the terminal-void notice as danger above the proofs', () => {
    renderPanel({ cardVoidCopy: CARD_VOID });
    const notice = screen.getByTestId(IDS.cardVoid);
    expect(notice).toHaveAttribute('data-tone', 'danger');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent(CARD_VOID);
    expect(
      notice.compareDocumentPosition(screen.getByTestId(IDS.panel)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders no void notice and no drawer slot when none is passed', () => {
    renderPanel();
    expect(screen.queryByTestId(IDS.cardVoid)).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer-slot')).not.toBeInTheDocument();
  });

  it('renders the drawer slot it is given', () => {
    renderPanel({ drawerNotice: <p data-testid="drawer-slot">درج</p> });
    expect(screen.getByTestId('drawer-slot')).toBeInTheDocument();
  });
});

describe('RT-243 completion — «بيع جديد» focus and the held-Enter guard', () => {
  it('moves focus to «بيع جديد» on mount (freeze 15 §3.2)', () => {
    renderPanel();
    expect(screen.getByTestId(IDS.newSale)).toHaveFocus();
    expect(screen.getByTestId(IDS.newSale)).toHaveAccessibleName('بيع جديد');
  });

  it('swallows an Enter inside the arm window and a key repeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T09:00:00.000Z'));
    renderPanel();
    const button = screen.getByTestId(IDS.newSale);

    const early = fireEvent.keyDown(button, { key: 'Enter' });
    expect(early).toBe(false); // default prevented

    vi.setSystemTime(new Date('2026-10-09T09:00:01.000Z'));
    const held = fireEvent.keyDown(button, { key: 'Enter', repeat: true });
    expect(held).toBe(false);

    const deliberate = fireEvent.keyDown(button, { key: 'Enter' });
    expect(deliberate).toBe(true);
  });

  it('starts a new sale on click', () => {
    const { onNewSale } = renderPanel();
    fireEvent.click(screen.getByTestId(IDS.newSale));
    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op without a handler', () => {
    renderPanel({ onNewSale: undefined });
    expect(() => fireEvent.click(screen.getByTestId(IDS.newSale))).not.toThrow();
  });
});

describe('RT-243 completion — accessibility', () => {
  it('has no axe violations with change, a void notice and a drawer slot', async () => {
    const { container } = render(
      <main>
        <CompletionPanel
          paidMinor={99_225}
          changeDueMinor={775}
          saleFinalization
          cardVoidCopy={CARD_VOID}
          drawerNotice={<p>لم يُفتح درج النقود. افتحه يدويًا.</p>}
          operator={<span>أحمد</span>}
          testIds={IDS}
        />
      </main>,
    );
    await expectNoAxeViolations(container);
  });

  it('names the screen and its one heading', () => {
    renderPanel();
    expect(screen.getByRole('region', { name: 'الدفع' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'الدفع' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'حالة البيع' })).toBeInTheDocument();
  });
});
