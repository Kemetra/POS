/**
 * RT-530 — the void screen: find a sale by its number, void it with another
 * manager's PIN, and the queued voids with what each waits for. A refused void
 * stays visible until acknowledged; the approval is bound to this sale and a
 * refused approval never reaches the void request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { VOID_COPY, voidRefusalMessage, voidWaitingMessage } from '../void-copy';
import { VoidScreen } from '../VoidScreen';
import {
  MANAGER,
  SALE_NUMBER,
  fakeBridges,
  journalView,
  saleView,
  type FakeBridges,
} from './__helpers__/void-fixtures';

afterEach(cleanup);

const PIN = '246810';

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

async function openDialog(): Promise<void> {
  await find();
  await userEvent.setup().click(screen.getByRole('button', { name: VOID_COPY.voidAction }));
  await screen.findByRole('dialog');
}

const pinBox = () => screen.findByLabelText(VOID_COPY.pinLabel);
const approveButton = () => screen.getByRole('button', { name: VOID_COPY.approve });

async function chooseManagerAndPin(pin = PIN): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText(MANAGER.display_name));
  await user.type(await pinBox(), pin);
}

describe('lookup', () => {
  it('finds the sale by its number and shows its total, cash and the void action', async () => {
    const bridges = show();
    await find();
    expect(bridges.saleVoid.lookup).toHaveBeenCalledWith({ sale_number: SALE_NUMBER });
    const card = screen.getByTestId('void-sale');
    expect(card).toHaveTextContent(SALE_NUMBER);
    expect(card).toHaveTextContent('رنا الكاشير');
    expect(screen.getByRole('button', { name: VOID_COPY.voidAction })).toBeEnabled();
  });

  it('says why a sale cannot be voided and offers no void action', async () => {
    show(fakeBridges([], saleView({ ineligible: 'not_same_day' })));
    await find();
    expect(screen.getByRole('alert')).toHaveTextContent(voidRefusalMessage('not_same_day'));
    expect(screen.queryByRole('button', { name: VOID_COPY.voidAction })).not.toBeInTheDocument();
  });

  it.each(['already_voided', 'has_return'] as const)('shows the %s refusal', async (ineligible) => {
    show(fakeBridges([], saleView({ ineligible })));
    await find();
    expect(screen.getByRole('alert')).toHaveTextContent(voidRefusalMessage(ineligible));
  });

  it('shows a refused lookup in Arabic', async () => {
    const bridges = fakeBridges();
    bridges.saleVoid.lookup.mockResolvedValueOnce({ kind: 'refused', reason: 'sale_not_found' });
    show(bridges);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(VOID_COPY.numberLabel), 'nope');
    await user.click(screen.getByRole('button', { name: VOID_COPY.search }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('sale_not_found'),
    );
  });

  it('makes no lookup call for an empty number', async () => {
    const bridges = show();
    await userEvent.setup().click(screen.getByRole('button', { name: VOID_COPY.search }));
    expect(bridges.saleVoid.lookup).not.toHaveBeenCalled();
  });
});

describe('the void dialog', () => {
  it('lists the managers who may approve a sale void and stays disabled until name and PIN are set', async () => {
    const bridges = show();
    await openDialog();
    expect(bridges.approval.listApprovers).toHaveBeenCalledWith({ action_kind: 'sale.void' });
    expect(await screen.findByLabelText(MANAGER.display_name)).toBeInTheDocument();
    expect(approveButton()).toBeDisabled();
    const user = userEvent.setup();
    await user.type(await pinBox(), '123');
    expect(approveButton()).toBeDisabled();
    await user.click(screen.getByLabelText(MANAGER.display_name));
    await user.type(await pinBox(), '456');
    expect(approveButton()).toBeEnabled();
  });

  it('binds the approval to THIS sale, then spends it on the void request, clearing the PIN', async () => {
    const bridges = show();
    await openDialog();
    await chooseManagerAndPin();
    await userEvent.setup().click(approveButton());
    await waitFor(() => {
      expect(bridges.saleVoid.request).toHaveBeenCalledTimes(1);
    });
    expect(bridges.approval.request).toHaveBeenCalledWith({
      action_kind: 'sale.void',
      subject_ref: 'sale-1',
      reason_code: 'sale_void',
      approver_ref: MANAGER.approver_ref,
      pin: PIN,
    });
    expect(bridges.saleVoid.request).toHaveBeenCalledWith({
      sale_id: 'sale-1',
      approval_id: '0190f5a2-3b4c-7d8e-9f01-000000000001',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByTestId('void-requested')).toHaveTextContent(VOID_COPY.requested);
  });

  it('shows the four-eyes refusal in Arabic and never reaches the void request', async () => {
    const bridges = fakeBridges();
    bridges.approval.request.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
    show(bridges);
    await openDialog();
    await chooseManagerAndPin();
    await userEvent.setup().click(approveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('approval_unavailable'),
    );
    expect(bridges.saleVoid.request).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await pinBox()).toHaveValue('');
  });

  it.each(['not_same_day', 'no_operator_envelope', 'already_voided', 'approval_stale'] as const)(
    'shows a refused void request (%s) inside the dialog and keeps it open',
    async (reason) => {
      const bridges = fakeBridges();
      bridges.saleVoid.request.mockResolvedValueOnce({ kind: 'refused', reason });
      show(bridges);
      await openDialog();
      await chooseManagerAndPin();
      await userEvent.setup().click(approveButton());
      expect(await screen.findByRole('alert')).toHaveTextContent(voidRefusalMessage(reason));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    },
  );

  it('says there is no manager to approve when none is enrolled', async () => {
    const bridges = fakeBridges();
    bridges.approval.listApprovers.mockResolvedValueOnce({ kind: 'approvers', approvers: [] });
    show(bridges);
    await openDialog();
    expect(await screen.findByText(VOID_COPY.noManagers)).toBeInTheDocument();
    expect(approveButton()).toBeDisabled();
  });

  it('keeps the approver read refusal, and an unreachable bridge reads as unavailable', async () => {
    const refused = fakeBridges();
    refused.approval.listApprovers.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'session_locked',
    });
    show(refused);
    await openDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('session_locked'),
    );
    cleanup();

    const broken = fakeBridges();
    broken.approval.listApprovers.mockRejectedValueOnce(new Error('ipc down'));
    show(broken);
    await openDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent(VOID_COPY.unavailable);
  });

  it('a bridge that rejects while sending reads as unavailable, never as success', async () => {
    const bridges = fakeBridges();
    bridges.saleVoid.request.mockRejectedValueOnce(new Error('ipc down'));
    show(bridges);
    await openDialog();
    await chooseManagerAndPin();
    await userEvent.setup().click(approveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(VOID_COPY.unavailable);
    expect(screen.queryByTestId('void-requested')).not.toBeInTheDocument();
  });

  it('closes on back without any void request', async () => {
    const bridges = show();
    await openDialog();
    await userEvent.setup().click(screen.getByRole('button', { name: VOID_COPY.back }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridges.saleVoid.request).not.toHaveBeenCalled();
    expect(bridges.approval.request).not.toHaveBeenCalled();
  });
});

describe('the queued voids', () => {
  const rows = () => screen.getAllByTestId('void-row');

  it('shows an empty list, and a load failure', async () => {
    show();
    expect(await screen.findByText(VOID_COPY.noHistory)).toBeInTheDocument();
    cleanup();
    const broken = fakeBridges();
    broken.saleVoid.list.mockRejectedValueOnce(new Error('ipc down'));
    show(broken);
    expect(await screen.findByRole('alert')).toHaveTextContent(VOID_COPY.unavailable);
  });

  it('names the requester a void waits for, and a void waiting for its sale to sync', async () => {
    show(
      fakeBridges([
        journalView({
          void_id: 'a',
          waiting_for: 'requester_sign_in',
          requester_display_name: 'منى المديرة',
        }),
        journalView({ void_id: 'b', waiting_for: 'sale_sync' }),
      ]),
    );
    expect(await screen.findAllByTestId('void-row')).toHaveLength(2);
    const [first, second] = rows();
    expect(first).toHaveTextContent(voidWaitingMessage('requester_sign_in', 'منى المديرة'));
    expect(first).toHaveTextContent('بانتظار تسجيل دخول منى المديرة متصلًا لإرسال الإلغاء');
    expect(second).toHaveTextContent(voidWaitingMessage('sale_sync', ''));
  });

  it('shows pending, unknown and confirmed rows by state, none flagged', async () => {
    show(
      fakeBridges([
        journalView({ void_id: 'a', state: 'pending' }),
        journalView({ void_id: 'b', state: 'unknown' }),
        journalView({ void_id: 'c', state: 'confirmed', confirmed_at: '2026-06-07T10:40:00.000Z' }),
      ]),
    );
    await screen.findAllByTestId('void-row');
    expect(rows().map((r) => r.getAttribute('data-state'))).toEqual([
      'pending',
      'unknown',
      'confirmed',
    ]);
    expect(rows().every((r) => r.getAttribute('data-attention') === 'false')).toBe(true);
    expect(rows()[2]).toHaveTextContent('تم الإلغاء');
  });

  it('shows a void Backend-Core refused with its reason, flagged, until it is acknowledged', async () => {
    const bridges = fakeBridges([
      journalView({
        state: 'refused',
        refusal_reason: 'void_outside_business_day',
        needs_attention: true,
      }),
    ]);
    show(bridges);
    const row = (await screen.findAllByTestId('void-row'))[0] as HTMLElement;
    expect(row).toHaveAttribute('data-attention', 'true');
    expect(within(row).getByRole('alert')).toHaveTextContent(
      voidRefusalMessage('void_outside_business_day'),
    );
    expect(within(row).getByRole('alert')).toHaveTextContent('استخدم المرتجعات');
    await userEvent.setup().click(within(row).getByRole('button', { name: VOID_COPY.acknowledge }));
    expect(bridges.saleVoid.acknowledge).toHaveBeenCalledWith({ void_id: 'void-1' });
    await waitFor(() => {
      expect(bridges.saleVoid.list).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps an acknowledged refusal on the list, no longer flagged and without the button', async () => {
    show(
      fakeBridges([
        journalView({
          state: 'refused',
          refusal_reason: 'void_self_approval',
          needs_attention: false,
        }),
      ]),
    );
    const row = (await screen.findAllByTestId('void-row'))[0] as HTMLElement;
    expect(row).toHaveAttribute('data-attention', 'false');
    expect(within(row).getByRole('alert')).toHaveTextContent(
      voidRefusalMessage('void_self_approval'),
    );
    expect(
      within(row).queryByRole('button', { name: VOID_COPY.acknowledge }),
    ).not.toBeInTheDocument();
  });

  it('shows what the new request waits for right after it is journaled', async () => {
    const bridges = fakeBridges();
    bridges.saleVoid.request.mockResolvedValueOnce({
      kind: 'requested',
      void: journalView({ waiting_for: 'sale_sync' }),
    });
    show(bridges);
    await openDialog();
    await chooseManagerAndPin();
    await userEvent.setup().click(approveButton());
    const notice = await screen.findByTestId('void-requested');
    expect(notice).toHaveTextContent(voidWaitingMessage('sale_sync', ''));
  });
});
