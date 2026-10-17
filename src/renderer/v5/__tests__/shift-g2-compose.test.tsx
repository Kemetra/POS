/**
 * RT-658 — the shift family recomposed on the G-2 references
 * (docs/design/vnext/visual-acceptance/G2-Shift/, merged in #736):
 * the G-6 page header (ScreenSection h1) and cards in place of the RT-17
 * sunken titlebar, outcomes and refusals as v5 Notices, the opening time in a
 * <time> set in the body face (never the LTR mono run), and amounts LTR
 * tabular. Behaviour is covered by shift-route / shift-manager-route; these
 * tests pin the composition only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ShiftStatusView } from '../../../shared/shift-cashup/types';
import { V5ShiftManagerRoute } from '../shift/V5ShiftManagerRoute';
import { V5ShiftRoute } from '../shift/V5ShiftRoute';
import { SHIFT_COPY, shiftRefusalMessage } from '../shift/shift-copy';
import {
  MANAGERS,
  OPENED_AT,
  enableShiftFlag,
  fakeShiftBridge,
  openShiftView,
  renderAt,
  resetShiftStores,
  signIn,
  statusView,
  type FakeShiftBridge,
} from './__helpers__/shift-test-kit';

afterEach(() => {
  cleanup();
  resetShiftStores();
  delete (window as unknown as { api?: unknown }).api;
});

const OPEN: ShiftStatusView = statusView({ openShift: openShiftView() });

function cashier(bridge: FakeShiftBridge) {
  signIn('cashier');
  enableShiftFlag();
  return renderAt({
    path: '/app/shift',
    pattern: '/app/shift',
    element: <V5ShiftRoute bridge={bridge} />,
  });
}

function manager(bridge: FakeShiftBridge) {
  signIn('manager');
  enableShiftFlag();
  return renderAt({
    path: '/app/shift/manager',
    pattern: '/app/shift/manager',
    element: <V5ShiftManagerRoute bridge={bridge} />,
  });
}

function press(name: string, scope: HTMLElement = document.body): void {
  fireEvent.click(within(scope).getByRole('button', { name }));
}

/** The opening time is Arabic text: a <time>, never inside the LTR or mono amount run. */
function expectDubaiTime(scope: HTMLElement): void {
  const time = scope.querySelector('time');
  expect(time).not.toBeNull();
  expect(time).toHaveAttribute('datetime', OPENED_AT);
  expect(time?.closest('.v5-ltr, .v5-shift-money')).toBeNull();
}

describe('RT-658 — the cashier screen on the G-6 page header', () => {
  it('names the screen with the ScreenSection h1, not the RT-17 titlebar', async () => {
    const { container } = cashier(fakeShiftBridge());
    expect(await screen.findByRole('heading', { level: 1, name: SHIFT_COPY.title })).toHaveClass(
      'v5-screen-section__title',
    );
    expect(container.querySelector('.v5-shift-titlebar')).toBeNull();
    expect(container.querySelector('.v5-shift-page')).not.toBeNull();
  });

  it('draws the opening form as one card, the amount LTR', async () => {
    cashier(fakeShiftBridge());
    const card = await screen.findByRole('region', { name: SHIFT_COPY.openHeading });
    expect(card).toHaveClass('v5-shift-card');
    expect(within(card).getByLabelText(SHIFT_COPY.floatLabel)).toHaveAttribute('dir', 'ltr');
    expect(within(card).getByRole('button', { name: SHIFT_COPY.openCommit })).toBeInTheDocument();
  });

  it('marks an invalid float on the field and shows a warning notice', async () => {
    cashier(fakeShiftBridge());
    const card = await screen.findByRole('region', { name: SHIFT_COPY.openHeading });
    fireEvent.change(within(card).getByLabelText(SHIFT_COPY.floatLabel), {
      target: { value: '12.345' },
    });
    press(SHIFT_COPY.openCommit, card);
    const alert = within(card).getByRole('alert');
    expect(alert.querySelector('.v5-notice[data-tone="warning"]')).not.toBeNull();
    expect(alert).toHaveTextContent(SHIFT_COPY.invalidAmount);
    const input = within(card).getByLabelText(SHIFT_COPY.floatLabel);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('puts the summary card and the close card side by side', async () => {
    const { container } = cashier(fakeShiftBridge(OPEN));
    const summary = await screen.findByTestId('shift-summary');
    expect(summary).toHaveClass('v5-shift-card');
    const close = screen.getByRole('region', { name: SHIFT_COPY.closeHeading });
    const grid = container.querySelector('.v5-shift-grid');
    expect(grid).toContainElement(summary);
    expect(grid).toContainElement(close);
  });

  it('sets the opening time in a <time>, and only the amounts LTR tabular', async () => {
    cashier(fakeShiftBridge(OPEN));
    const summary = await screen.findByTestId('shift-summary');
    const heading = within(summary).getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent(SHIFT_COPY.openSince);
    expectDubaiTime(heading);
    const amounts = summary.querySelectorAll('.v5-shift-money');
    expect(amounts).toHaveLength(3);
    for (const amount of Array.from(amounts)) expect(amount.closest('.v5-ltr')).not.toBeNull();
  });

  it('shows the opened outcome as a success notice with the way to the Sale', async () => {
    const bridge = fakeShiftBridge();
    bridge.status
      .mockResolvedValueOnce({ kind: 'status', status: statusView() })
      .mockResolvedValue({ kind: 'status', status: OPEN });
    cashier(bridge);
    const card = await screen.findByRole('region', { name: SHIFT_COPY.openHeading });
    fireEvent.change(within(card).getByLabelText(SHIFT_COPY.floatLabel), {
      target: { value: '500' },
    });
    press(SHIFT_COPY.openCommit, card);
    const opened = await screen.findByText(SHIFT_COPY.opened);
    const notice = opened.closest('.v5-notice');
    expect(notice).toHaveAttribute('data-tone', 'success');
    expect(
      within(notice as HTMLElement).getByRole('link', { name: SHIFT_COPY.goToSale }),
    ).toHaveAttribute('href', '/app/cart');
  });

  it('shows an approved close as a success notice with its variance LTR', async () => {
    const bridge = fakeShiftBridge(OPEN);
    bridge.close
      .mockResolvedValueOnce({ kind: 'refused', reason: 'variance_approval_required' })
      .mockResolvedValue({
        kind: 'closed',
        shiftId: 's',
        closedAt: OPENED_AT,
        varianceMinor: -2_500,
      });
    bridge.status
      .mockResolvedValueOnce({ kind: 'status', status: OPEN })
      .mockResolvedValue({ kind: 'status', status: statusView() });
    cashier(bridge);
    const close = await screen.findByRole('region', { name: SHIFT_COPY.closeHeading });
    fireEvent.change(within(close).getByLabelText(SHIFT_COPY.countLabel), {
      target: { value: '2425' },
    });
    press(SHIFT_COPY.closeCommit, close);
    const dialog = await screen.findByRole('dialog', { name: SHIFT_COPY.approvalTitle });
    fireEvent.click(await within(dialog).findByLabelText(MANAGERS[0].displayName));
    fireEvent.change(within(dialog).getByLabelText(SHIFT_COPY.pinLabel), {
      target: { value: '482913' },
    });
    press(SHIFT_COPY.approveCommit, dialog);
    const outcome = await screen.findByTestId('shift-closed-outcome');
    expect(outcome).toHaveClass('v5-notice');
    expect(outcome).toHaveAttribute('data-tone', 'success');
    const variance = within(outcome).getByTestId('shift-variance');
    expect(variance.querySelector('.v5-ltr.v5-shift-money')).toHaveTextContent('−25.00 EGP');
  });

  it('shows a refused status read as a warning notice with its retry inside', async () => {
    const bridge = fakeShiftBridge();
    bridge.status.mockResolvedValueOnce({ kind: 'refused', reason: 'unavailable' });
    cashier(bridge);
    const text = await screen.findByText(shiftRefusalMessage('unavailable'));
    const notice = text.closest('.v5-notice');
    expect(notice).toHaveAttribute('data-tone', 'warning');
    expect(
      within(notice as HTMLElement).getByRole('button', { name: SHIFT_COPY.retry }),
    ).toBeInTheDocument();
  });
});

describe('RT-658 — the cashier dialogs', () => {
  it('lays the movement dialog out as labelled fields, the amount LTR', async () => {
    cashier(fakeShiftBridge(OPEN));
    press(SHIFT_COPY.payOut, await screen.findByTestId('shift-summary'));
    const dialog = screen.getByRole('dialog', { name: SHIFT_COPY.payOut });
    expect(within(dialog).getByRole('heading', { name: SHIFT_COPY.payOut })).toHaveClass(
      'v5-shift-dialog-title',
    );
    expect(within(dialog).getByLabelText(SHIFT_COPY.amountLabel)).toHaveAttribute('dir', 'ltr');
    expect(within(dialog).getByLabelText(SHIFT_COPY.reasonLabel)).toHaveClass('v5-shift-select');
    expect(within(dialog).getByLabelText(SHIFT_COPY.noteLabel)).toHaveClass('v5-shift-textarea');
  });

  it('shows a refused pay-out as a warning notice inside the dialog', async () => {
    const bridge = fakeShiftBridge(OPEN);
    bridge.payOut.mockResolvedValueOnce({ kind: 'refused', reason: 'pay_out_not_accepted' });
    cashier(bridge);
    press(SHIFT_COPY.payOut, await screen.findByTestId('shift-summary'));
    const dialog = screen.getByRole('dialog', { name: SHIFT_COPY.payOut });
    fireEvent.change(within(dialog).getByLabelText(SHIFT_COPY.amountLabel), {
      target: { value: '3000' },
    });
    press(SHIFT_COPY.record, dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert.querySelector('.v5-notice[data-tone="warning"]')).not.toBeNull();
    expect(alert).toHaveTextContent(shiftRefusalMessage('pay_out_not_accepted'));
  });

  it('lists the managers in the approval as whole-line choices', async () => {
    const bridge = fakeShiftBridge(OPEN);
    bridge.close.mockResolvedValueOnce({ kind: 'refused', reason: 'variance_approval_required' });
    cashier(bridge);
    const close = await screen.findByRole('region', { name: SHIFT_COPY.closeHeading });
    fireEvent.change(within(close).getByLabelText(SHIFT_COPY.countLabel), {
      target: { value: '10' },
    });
    press(SHIFT_COPY.closeCommit, close);
    const dialog = await screen.findByRole('dialog', { name: SHIFT_COPY.approvalTitle });
    const radio = await within(dialog).findByLabelText(MANAGERS[1].displayName);
    expect(radio.closest('label')).toHaveClass('v5-shift-choice');
  });
});

/*
 * Regression guard. The failing reproduction is the browser walk
 * (docs/design/vnext/captures/RT-658/tools/walk-rt658.cjs, cashierClose): in
 * Chromium the commit is disabled under the dialog, so the dialog's own focus
 * restore found nothing to return to and focus fell to <body>. jsdom keeps
 * focus on a disabled button, so it cannot fail the same way.
 */
describe('RT-658 — keyboard: focus after the approval dialog', () => {
  it('returns focus to the close commit when the approval is cancelled', async () => {
    const bridge = fakeShiftBridge(OPEN);
    bridge.close.mockResolvedValueOnce({ kind: 'refused', reason: 'variance_approval_required' });
    cashier(bridge);
    const close = await screen.findByRole('region', { name: SHIFT_COPY.closeHeading });
    fireEvent.change(within(close).getByLabelText(SHIFT_COPY.countLabel), {
      target: { value: '10' },
    });
    const commit = within(close).getByRole('button', { name: SHIFT_COPY.closeCommit });
    commit.focus();
    fireEvent.click(commit);
    const dialog = await screen.findByRole('dialog', { name: SHIFT_COPY.approvalTitle });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(commit).toHaveFocus();
    });
  });
});

describe('RT-658 — the manager page on the G-6 cards', () => {
  it('names the page with the ScreenSection h1 and draws two cards', async () => {
    const { container } = manager(fakeShiftBridge(OPEN));
    expect(
      await screen.findByRole('heading', { level: 1, name: SHIFT_COPY.managerTitle }),
    ).toHaveClass('v5-screen-section__title');
    expect(container.querySelector('.v5-shift-titlebar')).toBeNull();
    const status = await screen.findByRole('region', { name: SHIFT_COPY.statusHeading });
    const pin = screen.getByRole('region', { name: SHIFT_COPY.enrollHeading });
    for (const card of [status, pin]) expect(card).toHaveClass('v5-shift-card');
    expect(container.querySelector('.v5-shift-mgr-grid')).toContainElement(pin);
  });

  it('puts the refresh in the status card head', async () => {
    manager(fakeShiftBridge(OPEN));
    const status = await screen.findByRole('region', { name: SHIFT_COPY.statusHeading });
    const head = status.querySelector('.v5-shift-card__head');
    expect(
      within(head as HTMLElement).getByRole('button', { name: SHIFT_COPY.refresh }),
    ).toBeInTheDocument();
  });

  it('sets the opening time in a <time> in the figures, the amounts LTR tabular', async () => {
    manager(fakeShiftBridge(OPEN));
    const figures = await screen.findByTestId('shift-status-open');
    expect(figures).toHaveClass('v5-shift-figures');
    expectDubaiTime(figures);
    expect(
      figures.querySelectorAll('.v5-ltr .v5-shift-money, .v5-ltr.v5-shift-money'),
    ).toHaveLength(3);
  });

  it('shows the stranded warning as a warning notice above the cards', async () => {
    const { container } = manager(
      fakeShiftBridge(statusView({ stranded: { unsyncedFacts: 2, openShifts: 0 } })),
    );
    const warning = await screen.findByTestId('shift-stranded-warning');
    expect(warning).toHaveAttribute('role', 'alert');
    expect(warning.querySelector('.v5-notice[data-tone="warning"]')).not.toBeNull();
    expect(container.querySelector('.v5-shift-mgr-grid')).not.toContainElement(warning);
  });

  it('keeps a refused read inside the status card, with its retry', async () => {
    const bridge = fakeShiftBridge();
    bridge.status.mockResolvedValueOnce({ kind: 'refused', reason: 'unavailable' });
    manager(bridge);
    const status = await screen.findByRole('region', { name: SHIFT_COPY.statusHeading });
    const notice = await within(status).findByText(shiftRefusalMessage('unavailable'));
    expect(notice.closest('.v5-notice')).toHaveAttribute('data-tone', 'warning');
    press(SHIFT_COPY.retry, status);
    await waitFor(() => {
      expect(bridge.status).toHaveBeenCalledTimes(2);
    });
  });

  it('shows a saved PIN as a success notice', async () => {
    manager(fakeShiftBridge(OPEN));
    const pin = await screen.findByRole('region', { name: SHIFT_COPY.enrollHeading });
    fireEvent.change(within(pin).getByLabelText(SHIFT_COPY.newPinLabel), {
      target: { value: '482913' },
    });
    fireEvent.change(within(pin).getByLabelText(SHIFT_COPY.confirmPinLabel), {
      target: { value: '482913' },
    });
    press(SHIFT_COPY.enrollCommit, pin);
    const saved = await within(pin).findByText(SHIFT_COPY.enrolled);
    expect(saved.closest('.v5-notice')).toHaveAttribute('data-tone', 'success');
  });
});
