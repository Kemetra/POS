/**
 * RT-654 — the void screen on the G-6 vocabulary (frozen references
 * docs/design/vnext/visual-acceptance/VD-Void/, owner-approved OD-1…OD-8):
 * the ScreenSection page header, two panels, 44px V5 controls instead of the
 * `v5-live-btn` pills, Dubai for Arabic (times and names are never in the
 * monospace face), LTR tabular runs for the sale number and amounts only,
 * refusals as V5 notices, the journal as a focusable scroll region, and the
 * confirm on the V5 Dialog with the danger commit. Behaviour is unchanged
 * (void-screen.test.tsx).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { VOID_COPY, voidRefusalMessage } from '../void-copy';
import { VoidScreen } from '../VoidScreen';
import {
  SALE_NUMBER,
  fakeBridges,
  journalView,
  saleView,
  type FakeBridges,
} from './__helpers__/void-fixtures';

afterEach(cleanup);

function show(bridges: FakeBridges = fakeBridges()) {
  render(<VoidScreen bridges={bridges} refreshMs={0} />);
  return bridges;
}

async function find(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(VOID_COPY.numberLabel), SALE_NUMBER);
  await user.click(screen.getByRole('button', { name: VOID_COPY.search }));
  await screen.findByTestId('void-sale');
}

const MONO = 'v5-void-num';

describe('the G-6 page (RT-654)', () => {
  it('is a ScreenSection named by its one h1, with no shift strip', async () => {
    show();
    await screen.findByText(VOID_COPY.noHistory);
    const section = screen.getByTestId('v5-screen-section');
    expect(section).toHaveAccessibleName(VOID_COPY.title);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.querySelector('.v5-shift-titlebar')).toBeNull();
    expect(document.querySelector('.v5-shift')).toBeNull();
  });

  it('has two named panels: the lookup and the void journal', async () => {
    show();
    await screen.findByText(VOID_COPY.noHistory);
    expect(screen.getByRole('region', { name: VOID_COPY.lookupHeading })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: VOID_COPY.historyTitle })).toBeInTheDocument();
  });

  it('uses V5 buttons, never the live-sale pills', async () => {
    show();
    await find();
    expect(document.querySelector('.v5-live-btn')).toBeNull();
    expect(screen.getByRole('button', { name: VOID_COPY.search })).toHaveClass(
      'v5-void-btn',
      'v5-void-btn--primary',
    );
  });

  it('shows the hint before a search, as muted text', () => {
    show();
    expect(screen.getByText(VOID_COPY.sameDayHint)).toHaveClass('v5-void-hint');
  });
});

describe('the found sale (RT-654)', () => {
  it('sets the sale number and amounts as LTR tabular runs, the time and seller in the text face', async () => {
    show();
    await find();
    const card = screen.getByTestId('void-sale');
    const mono = Array.from(card.querySelectorAll(`.${MONO}`)).map((n) => n.textContent);
    expect(mono).toEqual([SALE_NUMBER, '150.00 EGP', '150.00 EGP']);
    for (const n of Array.from(card.querySelectorAll(`.${MONO}`)))
      expect(n).toHaveAttribute('dir', 'ltr');
    const time = card.querySelector('time');
    expect(time).toHaveAttribute('datetime', '2026-06-07T10:00:00.000Z');
    expect(time).not.toHaveClass(MONO);
    expect(within(card).getByText('رنا الكاشير').closest(`.${MONO}`)).toBeNull();
  });

  it('offers the void as the danger action', async () => {
    show();
    await find();
    expect(screen.getByRole('button', { name: VOID_COPY.voidAction })).toHaveClass(
      'v5-void-btn',
      'v5-void-btn--danger',
    );
  });

  it('draws an ineligible sale as a V5 warning notice in place of the action', async () => {
    show(fakeBridges([], saleView({ ineligible: 'not_same_day' })));
    await find();
    const alert = within(screen.getByTestId('void-sale')).getByRole('alert');
    expect(alert.querySelector('.v5-notice[data-tone="warning"]')).toHaveTextContent(
      voidRefusalMessage('not_same_day'),
    );
  });

  it('draws a refused lookup as a V5 warning notice', async () => {
    const bridges = fakeBridges();
    bridges.saleVoid.lookup.mockResolvedValueOnce({ kind: 'refused', reason: 'sale_not_found' });
    show(bridges);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(VOID_COPY.numberLabel), 'nope');
    await user.click(screen.getByRole('button', { name: VOID_COPY.search }));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('.v5-notice[data-tone="warning"]')).not.toBeNull();
  });
});

describe('the void journal (RT-654)', () => {
  it('is a focusable list named by its heading, so it scrolls by keyboard', async () => {
    show(fakeBridges([journalView()]));
    const list = await screen.findByRole('list', { name: VOID_COPY.historyTitle });
    expect(list).toHaveAttribute('tabindex', '0');
  });

  it('draws the empty journal and a load failure as notices', async () => {
    show();
    expect((await screen.findByText(VOID_COPY.noHistory)).closest('.v5-notice')).not.toBeNull();
    cleanup();
    const broken = fakeBridges();
    broken.saleVoid.list.mockRejectedValueOnce(new Error('ipc down'));
    show(broken);
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('.v5-notice[data-tone="warning"]')).not.toBeNull();
  });

  it('gives each state its own tone and glyph, the number and amount as LTR runs', async () => {
    show(
      fakeBridges([
        journalView({ void_id: 'a', state: 'pending' }),
        journalView({ void_id: 'b', state: 'unknown' }),
        journalView({ void_id: 'c', state: 'confirmed' }),
        journalView({
          void_id: 'd',
          state: 'refused',
          refusal_reason: 'void_self_approval',
          needs_attention: true,
        }),
      ]),
    );
    const rows = await screen.findAllByTestId('void-row');
    const pills = rows.map((r) => r.querySelector('.v5-void-state'));
    expect(pills.map((p) => p?.getAttribute('data-tone'))).toEqual([
      'neutral',
      'neutral',
      'success',
      'danger',
    ]);
    expect(pills.map((p) => p?.querySelector('svg') !== null)).toEqual([true, true, true, true]);
    const first = rows[0] as HTMLElement;
    expect(Array.from(first.querySelectorAll(`.${MONO}`)).map((n) => n.textContent)).toEqual([
      SALE_NUMBER,
      '150.00 EGP',
    ]);
    expect(first.querySelector('time')).not.toHaveClass(MONO);
  });

  it('acknowledges with a 44px V5 button, not a pill', async () => {
    show(
      fakeBridges([
        journalView({ state: 'refused', refusal_reason: 'conflict', needs_attention: true }),
      ]),
    );
    const row = (await screen.findAllByTestId('void-row'))[0] as HTMLElement;
    expect(within(row).getByRole('button', { name: VOID_COPY.acknowledge })).toHaveClass(
      'v5-void-btn',
    );
  });

  it('shows the requested outcome as a V5 success notice', async () => {
    show();
    await find();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: VOID_COPY.voidAction }));
    await user.click(await screen.findByLabelText('كريم المدير'));
    await user.type(await screen.findByLabelText(VOID_COPY.pinLabel), '246810');
    await user.click(screen.getByRole('button', { name: VOID_COPY.approve }));
    const notice = await screen.findByTestId('void-requested');
    expect(notice).toHaveClass('v5-notice');
    expect(notice).toHaveAttribute('data-tone', 'success');
  });
});

describe('the confirm dialog (RT-654)', () => {
  async function openDialog(): Promise<HTMLElement> {
    await find();
    await userEvent.setup().click(screen.getByRole('button', { name: VOID_COPY.voidAction }));
    return screen.findByRole('dialog');
  }

  it('is the V5 Dialog, opening on «رجوع»', async () => {
    show();
    const dialog = await openDialog();
    expect(dialog).toHaveClass('v5-dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: VOID_COPY.back })).toHaveFocus();
  });

  it('summarises the sale as two LTR runs, without the dash', async () => {
    show();
    const dialog = await openDialog();
    const summary = dialog.querySelector('.v5-void-summary');
    expect(
      Array.from(summary?.querySelectorAll(`.${MONO}`) ?? []).map((n) => n.textContent),
    ).toEqual([SALE_NUMBER, '150.00 EGP']);
    expect(summary?.textContent).not.toContain('—');
  });

  it('commits with the danger button and keeps 44px manager choices', async () => {
    show();
    const dialog = await openDialog();
    expect(within(dialog).getByRole('button', { name: VOID_COPY.approve })).toHaveClass(
      'v5-void-btn',
      'v5-void-btn--danger',
    );
    const choice = (await within(dialog).findByLabelText('كريم المدير')).closest('label');
    expect(choice).toHaveClass('v5-void-choice');
    expect(within(dialog).getByLabelText(VOID_COPY.pinLabel)).toHaveClass('v5-void-input');
  });

  it('after a refusal, moves focus to «رجوع» so it never leaves the dialog', async () => {
    const bridges = fakeBridges();
    bridges.approval.request.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
    show(bridges);
    const dialog = await openDialog();
    const user = userEvent.setup();
    await user.click(await within(dialog).findByLabelText('كريم المدير'));
    await user.type(within(dialog).getByLabelText(VOID_COPY.pinLabel), '246810');
    await user.click(within(dialog).getByRole('button', { name: VOID_COPY.approve }));
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByRole('button', { name: VOID_COPY.back })).toHaveFocus();
  });

  it('after the request is journaled, returns focus to the sale number field', async () => {
    show();
    const dialog = await openDialog();
    const user = userEvent.setup();
    await user.click(await within(dialog).findByLabelText('كريم المدير'));
    await user.type(within(dialog).getByLabelText(VOID_COPY.pinLabel), '246810');
    await user.click(within(dialog).getByRole('button', { name: VOID_COPY.approve }));
    await screen.findByTestId('void-requested');
    expect(screen.getByLabelText(VOID_COPY.numberLabel)).toHaveFocus();
  });
});
