/**
 * RT-441 (RT-116 §5, spec 024 §4.3) — Manager → المبيعات المعلقة. What other
 * operators left on this terminal, as totals only: no line items, no park
 * label. Owners are named from the branch roster, or «موظف آخر».
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { formatCheckoutMoney } from '../../../ui/payments/format-checkout-money';
import { RecoveryScreen, windowRecoveryBridges } from '../RecoveryScreen';
import { RECOVERY_COPY, recoveryRefusalMessage } from '../recovery-copy';
import {
  OWNER_ID,
  fakeBridges,
  heldCart,
  heldView,
  roster,
  stuckAttempt,
  type FakeBridges,
} from './__helpers__/recovery-fixtures';

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

function show(bridges: FakeBridges) {
  render(<RecoveryScreen bridges={bridges} />);
  return bridges;
}

const panel = (name: string) => screen.getByRole('region', { name });

function fact(scope: HTMLElement, label: string): HTMLElement | null {
  const term = within(scope).queryByText(label, { selector: 'dt' });
  return term?.nextElementSibling instanceof HTMLElement ? term.nextElementSibling : null;
}

describe('RecoveryScreen — states', () => {
  it('shows loading, then both panels empty', async () => {
    show(fakeBridges());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(RECOVERY_COPY.title);
    expect(screen.getByRole('status')).toHaveTextContent(RECOVERY_COPY.loading);
    expect(await screen.findByText(RECOVERY_COPY.noneStuck)).toBeInTheDocument();
    expect(screen.getByText(RECOVERY_COPY.noneHeld)).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('shows a refused read with its message', async () => {
    const bridges = fakeBridges();
    bridges.recovery.listHeld.mockResolvedValueOnce({ kind: 'refused', reason: 'role_mismatch' });
    show(bridges);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      recoveryRefusalMessage('role_mismatch'),
    );
  });

  it('says unavailable when the read fails', async () => {
    const bridges = fakeBridges();
    bridges.recovery.listHeld.mockRejectedValueOnce(new Error('ipc down'));
    show(bridges);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      recoveryRefusalMessage('recovery_unavailable'),
    );
  });

  it('explains recovery mode', async () => {
    show(fakeBridges(heldView({ recovery_mode: true, stuck: stuckAttempt() })));
    expect(await screen.findByRole('note')).toHaveTextContent(RECOVERY_COPY.recoveryMode);
  });
});

describe('RecoveryScreen — the stuck payment', () => {
  it('shows totals and live tender only, never a zero tender line', async () => {
    show(fakeBridges(heldView({ stuck: stuckAttempt() })));
    await screen.findByText(RECOVERY_COPY.complete);
    const stuck = panel(RECOVERY_COPY.stuckTitle);
    expect(fact(stuck, RECOVERY_COPY.lines)).toHaveTextContent('3');
    expect(fact(stuck, RECOVERY_COPY.total)).toHaveTextContent(formatCheckoutMoney(15_000));
    expect(fact(stuck, RECOVERY_COPY.cash)).toHaveTextContent(formatCheckoutMoney(5_000));
    expect(fact(stuck, RECOVERY_COPY.remaining)).toHaveTextContent(formatCheckoutMoney(10_000));
    expect(fact(stuck, RECOVERY_COPY.card)).toBeNull();
    expect(fact(stuck, RECOVERY_COPY.voucher)).toBeNull();
  });

  it('shows card and voucher tender when live', async () => {
    show(
      fakeBridges(
        heldView({ stuck: stuckAttempt({ cash_minor: 0, card_minor: 7_000, voucher_minor: 900 }) }),
      ),
    );
    await screen.findByText(RECOVERY_COPY.complete);
    const stuck = panel(RECOVERY_COPY.stuckTitle);
    expect(fact(stuck, RECOVERY_COPY.cash)).toBeNull();
    expect(fact(stuck, RECOVERY_COPY.card)).toHaveTextContent(formatCheckoutMoney(7_000));
    expect(fact(stuck, RECOVERY_COPY.voucher)).toHaveTextContent(formatCheckoutMoney(900));
  });
});

describe('RecoveryScreen — held sales', () => {
  it('tags each held sale by state, flags a parked one, and shows only its totals', async () => {
    show(
      fakeBridges(
        heldView({
          held: [
            heldCart({ cart_id: 'c-1', kind: 'draft' }),
            heldCart({ cart_id: 'c-2', kind: 'handed_off', parked: true, total_minor: 9_900 }),
          ],
        }),
      ),
    );
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const [draft, parked] = rows as [HTMLElement, HTMLElement];
    expect(draft).toHaveTextContent(RECOVERY_COPY.draft);
    expect(draft).not.toHaveTextContent(RECOVERY_COPY.parked);
    expect(parked).toHaveTextContent(RECOVERY_COPY.handedOff);
    expect(parked).toHaveTextContent(RECOVERY_COPY.parked);
    expect(parked).toHaveTextContent(formatCheckoutMoney(9_900));
    expect(within(parked).getByRole('button', { name: RECOVERY_COPY.cancelSale })).toBeVisible();
  });

  it('names owners from the roster, else «موظف آخر»', async () => {
    show(
      fakeBridges(
        heldView({
          stuck: stuckAttempt({ owning_operator_id: 'op-gone' }),
          held: [heldCart()],
        }),
        roster({ [OWNER_ID]: 'أحمد سمير' }),
      ),
    );
    expect(await screen.findByText('أحمد سمير')).toBeInTheDocument();
    const owner = fact(panel(RECOVERY_COPY.stuckTitle), RECOVERY_COPY.owner);
    expect(owner).toHaveTextContent(RECOVERY_COPY.someoneElse);
    // A name is set in the body face (the facts list is tabular): Arabic stays joined.
    expect(owner).toHaveClass('v5-recovery-text');
    expect(fact(panel(RECOVERY_COPY.stuckTitle), RECOVERY_COPY.total)).not.toHaveClass(
      'v5-recovery-text',
    );
  });

  it('shows the manager’s own held sale as «أنت», never «موظف آخر» (RT-837)', async () => {
    show(fakeBridges(heldView({ held: [heldCart({ own: true })] })));
    const row = (await screen.findByText(RECOVERY_COPY.you)).closest('li') as HTMLElement;
    expect(row).not.toHaveTextContent(RECOVERY_COPY.someoneElse);
    expect(within(row).getByRole('button', { name: RECOVERY_COPY.cancelSale })).toBeVisible();
  });

  it('falls back to «موظف آخر» when the roster is refused or fails', async () => {
    const refused = fakeBridges(heldView({ held: [heldCart()] }));
    refused.listRoster = () => Promise.resolve({ kind: 'refused', reason: 'no_session' } as never);
    show(refused);
    expect(await screen.findByText(RECOVERY_COPY.someoneElse)).toBeInTheDocument();
    cleanup();
    const failed = fakeBridges(heldView({ held: [heldCart()] }));
    failed.listRoster = () => Promise.reject(new Error('offline'));
    show(failed);
    expect(await screen.findByText(RECOVERY_COPY.someoneElse)).toBeInTheDocument();
  });
});

describe('RecoveryScreen — actions', () => {
  it('opens the action, reports the outcome and reloads the list', async () => {
    const bridges = show(fakeBridges(heldView({ held: [heldCart()] })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: RECOVERY_COPY.cancelSale }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      await within(dialog).findByLabelText(new RegExp(RECOVERY_COPY.pinLabel)),
      '246810',
    );
    await user.click(within(dialog).getByRole('button', { name: RECOVERY_COPY.approve }));
    expect(await screen.findByText(RECOVERY_COPY.cancelledSale)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(bridges.recovery.listHeld).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    [RECOVERY_COPY.complete, 'recovery.complete_attempt'],
    [RECOVERY_COPY.cancelPayment, 'recovery.cancel_attempt'],
  ])('opens «%s» for the stuck payment', async (label, kind) => {
    const bridges = show(fakeBridges(heldView({ stuck: stuckAttempt() })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: label }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(bridges.approval.listApprovers).toHaveBeenCalledWith({ action_kind: kind });
  });

  it('closes the dialog on رجوع without acting', async () => {
    const bridges = show(fakeBridges(heldView({ held: [heldCart()] })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: RECOVERY_COPY.cancelSale }));
    await user.click(await screen.findByRole('button', { name: RECOVERY_COPY.back }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bridges.recovery.cancelHeldCart).not.toHaveBeenCalled();
  });
});

describe('windowRecoveryBridges', () => {
  it('is null without the recovery or approval bridge', () => {
    expect(windowRecoveryBridges()).toBeNull();
    (window as unknown as { api: unknown }).api = { recovery: {} };
    expect(windowRecoveryBridges()).toBeNull();
  });

  it('reads both bridges, and the roster when the operator bridge has it', async () => {
    const { recovery, approval } = fakeBridges();
    (window as unknown as { api: unknown }).api = { recovery, approval };
    expect(windowRecoveryBridges()).toEqual({ recovery, approval });
    const listBranchRoster = () => Promise.resolve(roster({ a: 'منى' }));
    (window as unknown as { api: unknown }).api = {
      recovery,
      approval,
      operator: { listBranchRoster },
    };
    await expect(windowRecoveryBridges()?.listRoster?.()).resolves.toEqual(roster({ a: 'منى' }));
  });
});
