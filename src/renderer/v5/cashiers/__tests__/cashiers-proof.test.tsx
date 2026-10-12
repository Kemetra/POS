import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { REAUTH_COPY } from '../../../ui/operator/messages';
import { CASHIERS_COPY as C } from '../cashiers-copy';
import {
  CashiersProof,
  makeCashiersProofBridge,
  readCashiersProofParams,
  resetCashiersProofForTests,
} from '../dev/CashiersProof';

/**
 * RT-424 — the DEV-only Cashiers harness: its query parameters, its in-memory
 * bridge, and that it renders the real screen inside the real frame.
 */

afterEach(() => {
  cleanup();
  resetCashiersProofForTests();
  useOperatorSessionStore.getState().reset();
  window.location.hash = '';
});

describe('RT-424 CashiersProof — parameters', () => {
  it('defaults to the typical list and an accepted first PIN', () => {
    window.location.hash = '#/dev/cashiers-proof';
    expect(readCashiersProofParams()).toEqual({ list: 'typical', provision: 'ok' });
  });

  it('reads list and provision, and ignores unknown values', () => {
    window.location.hash = '#/dev/cashiers-proof?list=long&provision=reauth';
    expect(readCashiersProofParams()).toEqual({ list: 'long', provision: 'reauth' });
    window.location.hash = '#/dev/cashiers-proof?list=nope&provision=nope';
    expect(readCashiersProofParams()).toEqual({ list: 'typical', provision: 'ok' });
  });
});

describe('RT-424 CashiersProof — the in-memory bridge', () => {
  it('serves the typical, long and empty lists, with a lock time only on locked rows', async () => {
    const typical = await makeCashiersProofBridge({
      list: 'typical',
      provision: 'ok',
    }).listCashierPinStatus?.();
    if (typical?.kind !== 'cashiers') throw new Error('expected cashiers');
    expect(typical.cashiers).toHaveLength(6);
    expect(typical.cashiers.filter((c) => c.locked_until !== undefined).map((c) => c.pin)).toEqual([
      'locked',
    ]);
    const long = await makeCashiersProofBridge({
      list: 'long',
      provision: 'ok',
    }).listCashierPinStatus?.();
    expect(long?.kind === 'cashiers' && long.cashiers.length).toBe(18);
    const empty = await makeCashiersProofBridge({
      list: 'empty',
      provision: 'ok',
    }).listCashierPinStatus?.();
    expect(empty).toEqual({ kind: 'cashiers', cashiers: [] });
  });

  it.each([
    ['offline', 'no_connection'],
    ['refused', 'invalid_input'],
  ] as const)('the %s list refuses with %s', async (list, category) => {
    await expect(
      makeCashiersProofBridge({ list, provision: 'ok' }).listCashierPinStatus?.(),
    ).resolves.toEqual({ kind: 'refused', category });
  });

  it.each([
    ['not_ready', 'not_ready'],
    ['reauth', 'reauth_required'],
  ] as const)(
    'provision=%s refuses the first Save only, then accepts',
    async (provision, category) => {
      const bridge = makeCashiersProofBridge({ list: 'typical', provision });
      const req = { event_id: 'e', target_cashier_id: 'proof-cashier-1', initial_pin: '1234' };
      await expect(bridge.provisionCashierPin(req)).resolves.toEqual({ kind: 'refused', category });
      await expect(bridge.provisionCashierPin(req)).resolves.toEqual({
        kind: 'pin_provisioned',
        audit_event_id: 'e',
      });
    },
  );

  it('every action makes the row ready', async () => {
    const bridge = makeCashiersProofBridge({ list: 'typical', provision: 'ok' });
    await bridge.provisionCashierPin({
      event_id: 'a',
      target_cashier_id: 'proof-cashier-1',
      initial_pin: '1234',
    });
    await bridge.unlockCashier({ event_id: 'b', target_cashier_id: 'proof-cashier-2' });
    await bridge.resetCashierPin({
      event_id: 'c',
      target_cashier_id: 'proof-cashier-0',
      new_pin: '1234',
    });
    const res = await bridge.listCashierPinStatus?.();
    if (res?.kind !== 'cashiers') throw new Error('expected cashiers');
    expect(res.cashiers.slice(0, 3).map((c) => c.pin)).toEqual(['ready', 'ready', 'ready']);
    expect(res.cashiers[2]).not.toHaveProperty('locked_until');
    await expect(bridge.reauthenticate?.({ identifier: 'x', password: 'y' })).resolves.toEqual({
      kind: 'reauthenticated',
    });
  });
});

describe('RT-424 CashiersProof — the page', () => {
  // Review #1: the re-auth dialog must use the FRAME's DialogHost. A nested
  // host would portal into <main>, whose layout containment makes it the
  // backdrop's containing block, so the scrim would miss the nav.
  it('M6: the re-auth dialog renders outside <main>, in the frame’s dialog host', async () => {
    window.location.hash = '#/dev/cashiers-proof?provision=reauth';
    const user = userEvent.setup();
    render(<CashiersProof />);
    const rows = await screen.findAllByTestId('cashier-row');
    await user.click(
      within(rows[1] as HTMLElement).getByRole('button', { name: C.action.first_pin }),
    );
    await user.type(screen.getByLabelText(C.newPin), '4729');
    await user.type(screen.getByLabelText(C.confirmPin), '4729');
    await user.click(screen.getByRole('button', { name: C.save }));
    await user.click(await screen.findByRole('button', { name: REAUTH_COPY.action }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('main')).toBeNull();
    expect(dialog.closest('[data-testid="v5-frame"]')).not.toBeNull();
    expect(document.querySelectorAll('.v5-dialog-host')).toHaveLength(1);
  });

  it('renders the real screen inside the v5 frame as a manager', async () => {
    window.location.hash = '#/dev/cashiers-proof';
    const user = userEvent.setup();
    render(<CashiersProof />);
    expect(screen.getByTestId('v5-frame')).toBeInTheDocument();
    const rows = await screen.findAllByTestId('cashier-row');
    expect(rows).toHaveLength(6);
    await user.click(within(rows[2] as HTMLElement).getByRole('button', { name: C.action.unlock }));
    expect(await screen.findByTestId('action-success')).toHaveTextContent(C.done.unlock);
  });
});
