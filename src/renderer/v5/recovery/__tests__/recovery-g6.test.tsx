/**
 * RT-656 — Manager → المبيعات المعلقة on the G-6 page header and V5 controls
 * (docs/design/vnext/visual-acceptance/RC-Recovery, owner-approved). Behaviour
 * is RT-441's and unchanged; these tests pin the presentation the references
 * fix: the ScreenSection h1, the G-6 panels, V5 notices, LTR tabular amounts,
 * no shift header band, and the focus return after a refused PIN (OD-4).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { formatCheckoutMoney } from '../../../ui/payments/format-checkout-money';
import { RecoveryActionDialog } from '../RecoveryActionDialog';
import { RecoveryScreen } from '../RecoveryScreen';
import { RECOVERY_COPY, recoveryRefusalMessage } from '../recovery-copy';
import {
  fakeBridges,
  heldCart,
  heldView,
  stuckAttempt,
  type FakeBridges,
} from './__helpers__/recovery-fixtures';

afterEach(cleanup);

function show(bridges: FakeBridges) {
  const { container } = render(<RecoveryScreen bridges={bridges} />);
  return container;
}

const noticeOf = (el: HTMLElement) => el.closest('.v5-notice') ?? el.querySelector('.v5-notice');

describe('RecoveryScreen — the G-6 page header', () => {
  it('names the page with the ScreenSection h1, not the shift header band', async () => {
    const container = show(fakeBridges(heldView({ stuck: stuckAttempt(), held: [heldCart()] })));
    await screen.findByRole('button', { name: RECOVERY_COPY.complete });
    const section = screen.getByTestId('v5-screen-section');
    expect(section).toHaveAccessibleName(RECOVERY_COPY.title);
    expect(within(section).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(container.querySelector('[class*="v5-shift"]')).toBeNull();
  });

  it('draws both panels as G-6 panels named by their h2', async () => {
    show(fakeBridges(heldView({ stuck: stuckAttempt(), held: [heldCart()] })));
    await screen.findByRole('button', { name: RECOVERY_COPY.complete });
    for (const name of [RECOVERY_COPY.stuckTitle, RECOVERY_COPY.heldTitle]) {
      const panel = screen.getByRole('region', { name });
      expect(panel).toHaveClass('v5-recovery-panel');
      expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent(name);
    }
  });
});

describe('RecoveryScreen — V5 notices', () => {
  it('shows loading as a neutral notice', () => {
    show(fakeBridges());
    expect(noticeOf(screen.getByRole('status'))).toHaveAttribute('data-tone', 'info');
  });

  it('keeps recovery mode a note, drawn as a neutral notice', async () => {
    show(fakeBridges(heldView({ recovery_mode: true, stuck: stuckAttempt() })));
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent(RECOVERY_COPY.recoveryMode);
    expect(noticeOf(note)).toHaveAttribute('data-tone', 'info');
  });

  it('keeps a refused read an alert, drawn as a warning notice', async () => {
    const bridges = fakeBridges();
    bridges.recovery.listHeld.mockResolvedValueOnce({ kind: 'refused', reason: 'role_mismatch' });
    show(bridges);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(recoveryRefusalMessage('role_mismatch'));
    expect(noticeOf(alert)).toHaveAttribute('data-tone', 'warning');
  });

  it('reports an outcome as a success notice', async () => {
    show(fakeBridges(heldView({ held: [heldCart()] })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: RECOVERY_COPY.cancelSale }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      await within(dialog).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: RECOVERY_COPY.approve }));
    const outcome = await screen.findByText(RECOVERY_COPY.cancelledSale);
    expect(noticeOf(outcome)).toHaveAttribute('data-tone', 'success');
  });

  it('isolates the change amount in the outcome as an LTR run', async () => {
    const bridges = fakeBridges(heldView({ stuck: stuckAttempt() }));
    bridges.recovery.completeAttempt.mockResolvedValueOnce({
      kind: 'completed',
      change_due_minor: 5_000,
    });
    show(bridges);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: RECOVERY_COPY.complete }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(RECOVERY_COPY.cashReceived), '150');
    await user.type(
      await within(dialog).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: RECOVERY_COPY.approve }));
    const outcome = noticeOf(
      await screen.findByText(new RegExp(RECOVERY_COPY.change)),
    ) as HTMLElement;
    expect(within(outcome).getByText(formatCheckoutMoney(5_000))).toHaveClass('v5-recovery-money');
    expect(outcome).toHaveTextContent(
      `${RECOVERY_COPY.completed} ${RECOVERY_COPY.change}: ${formatCheckoutMoney(5_000)}`,
    );
  });

  it('draws an empty panel as a muted line', async () => {
    show(fakeBridges());
    expect(await screen.findByText(RECOVERY_COPY.noneHeld)).toHaveClass('v5-recovery-empty');
  });
});

describe('RecoveryScreen — amounts and controls', () => {
  it('sets every amount and count as an LTR tabular run', async () => {
    show(fakeBridges(heldView({ stuck: stuckAttempt(), held: [heldCart()] })));
    const [row] = await screen.findAllByRole('listitem');
    const amount = within(row as HTMLElement).getByText(formatCheckoutMoney(4_250));
    expect(amount).toHaveClass('v5-recovery-money');
    expect(within(row as HTMLElement).getByText('2')).toHaveClass('v5-recovery-money');
    const due = within(screen.getByRole('region', { name: RECOVERY_COPY.stuckTitle })).getByText(
      formatCheckoutMoney(10_000),
    );
    expect(due).toHaveClass('v5-recovery-money');
  });

  it('marks «إكمال البيع» primary and keeps both cancels neutral (OD-5)', async () => {
    show(fakeBridges(heldView({ stuck: stuckAttempt(), held: [heldCart()] })));
    const complete = await screen.findByRole('button', { name: RECOVERY_COPY.complete });
    expect(complete).toHaveClass('v5-recovery-btn', 'v5-recovery-btn--primary');
    for (const name of [RECOVERY_COPY.cancelPayment, RECOVERY_COPY.cancelSale]) {
      const btn = screen.getByRole('button', { name });
      expect(btn).toHaveClass('v5-recovery-btn');
      expect(btn).not.toHaveClass('v5-recovery-btn--primary');
    }
  });
});

describe('RecoveryActionDialog — G-6 dialog', () => {
  it('focuses رجوع first and returns focus to the PIN after a refused PIN (OD-4)', async () => {
    const bridges = fakeBridges();
    bridges.approval.request.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
    render(
      <RecoveryActionDialog
        action={{ kind: 'cancel_cart', cart: heldCart() }}
        bridges={bridges}
        onDismiss={() => undefined}
        onDone={() => undefined}
      />,
    );
    const pin = await screen.findByLabelText(new RegExp(RECOVERY_COPY.pinLabel));
    expect(screen.getByRole('button', { name: RECOVERY_COPY.back })).toHaveFocus();
    const user = userEvent.setup();
    await user.type(pin, '246810');
    await user.click(screen.getByRole('button', { name: RECOVERY_COPY.approve }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(recoveryRefusalMessage('approval_unavailable'));
    expect(noticeOf(alert)).toHaveAttribute('data-tone', 'warning');
    expect(pin).toHaveValue('');
    expect(pin).toHaveFocus();
  });

  it('draws the dialog controls as recovery buttons and the PIN as a code field', async () => {
    render(
      <RecoveryActionDialog
        action={{ kind: 'complete', stuck: stuckAttempt() }}
        bridges={fakeBridges()}
        onDismiss={() => undefined}
        onDone={() => undefined}
      />,
    );
    const pin = await screen.findByLabelText(new RegExp(RECOVERY_COPY.pinLabel));
    expect(pin).toHaveClass('v5-recovery-input', 'v5-recovery-input--pin');
    expect(screen.getByLabelText(RECOVERY_COPY.cashReceived)).toHaveClass(
      'v5-recovery-input',
      'v5-recovery-input--code',
    );
    expect(screen.getByRole('button', { name: RECOVERY_COPY.approve })).toHaveClass(
      'v5-recovery-btn--primary',
    );
    expect(screen.getByRole('button', { name: RECOVERY_COPY.back })).toHaveClass('v5-recovery-btn');
  });
});
