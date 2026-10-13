/**
 * RT-441 (RT-116 §5.2) — the recovery actions without React: what each needs
 * besides the approval, and exactly what each sends to main.
 */
import { describe, expect, it } from 'vitest';

import { formatCheckoutMoney } from '../../../ui/payments/format-checkout-money';
import {
  NO_EXTRAS,
  RECOVERY_ACTION_KIND,
  performRecoveryAction,
  recoveryExtrasReady,
  recoverySubjectOf,
  type RecoveryAction,
} from '../recovery-actions';
import { RECOVERY_COPY } from '../recovery-copy';
import { fakeRecoveryBridge, heldCart, stuckAttempt } from './__helpers__/recovery-fixtures';

const complete = (overrides = {}): RecoveryAction => ({
  kind: 'complete',
  stuck: stuckAttempt(overrides),
});
const cancelAttempt = (overrides = {}): RecoveryAction => ({
  kind: 'cancel_attempt',
  stuck: stuckAttempt(overrides),
});
const cancelCart: RecoveryAction = { kind: 'cancel_cart', cart: heldCart() };

describe('recovery action kinds and subjects', () => {
  it('maps each action to its own RT-114 action kind', () => {
    expect(RECOVERY_ACTION_KIND).toEqual({
      complete: 'recovery.complete_attempt',
      cancel_attempt: 'recovery.cancel_attempt',
      cancel_cart: 'recovery.cancel_held_cart',
    });
  });

  it('binds an attempt action to the attempt and a cart action to the cart', () => {
    expect(recoverySubjectOf(complete())).toBe('attempt-1');
    expect(recoverySubjectOf(cancelAttempt())).toBe('attempt-1');
    expect(recoverySubjectOf(cancelCart)).toBe('cart-held-1');
  });
});

describe('recoveryExtrasReady', () => {
  it('completes a fully tendered attempt with no cash', () => {
    expect(recoveryExtrasReady(complete({ remaining_minor: 0 }), NO_EXTRAS)).toBe(true);
  });

  it.each([
    ['nothing typed', '', false],
    ['not a number', 'abc', false],
    ['less than the remainder', '99.99', false],
    ['the exact remainder', '100', true],
    ['more than the remainder', '150.50', true],
    ['Arabic-Indic digits', '١٠٠', true],
  ])('needs cash covering the remainder: %s', (_label, cash, ready) => {
    expect(recoveryExtrasReady(complete(), { ...NO_EXTRAS, cash })).toBe(ready);
  });

  it('needs the cash-returned confirmation only when cash is live', () => {
    const cashOnly = cancelAttempt({ cash_minor: 5_000, card_minor: 0 });
    expect(recoveryExtrasReady(cashOnly, NO_EXTRAS)).toBe(false);
    expect(recoveryExtrasReady(cashOnly, { ...NO_EXTRAS, cashReturned: true })).toBe(true);
  });

  it('needs the card-void confirmation only when card is live', () => {
    const cardOnly = cancelAttempt({ cash_minor: 0, card_minor: 7_000 });
    expect(recoveryExtrasReady(cardOnly, NO_EXTRAS)).toBe(false);
    expect(recoveryExtrasReady(cardOnly, { ...NO_EXTRAS, cardVoided: true })).toBe(true);
  });

  it('needs both confirmations when cash and card are live', () => {
    const both = cancelAttempt({ cash_minor: 5_000, card_minor: 7_000 });
    expect(recoveryExtrasReady(both, { ...NO_EXTRAS, cashReturned: true })).toBe(false);
    expect(recoveryExtrasReady(both, { ...NO_EXTRAS, cardVoided: true })).toBe(false);
    expect(recoveryExtrasReady(both, { ...NO_EXTRAS, cashReturned: true, cardVoided: true })).toBe(
      true,
    );
  });

  it('needs nothing to cancel an attempt with only a voucher, or a held cart', () => {
    expect(
      recoveryExtrasReady(cancelAttempt({ cash_minor: 0, voucher_minor: 900 }), NO_EXTRAS),
    ).toBe(true);
    expect(recoveryExtrasReady(cancelCart, NO_EXTRAS)).toBe(true);
  });
});

describe('performRecoveryAction — complete', () => {
  it('sends the cash for the remainder in minor units, and says the change', async () => {
    const bridge = fakeRecoveryBridge();
    bridge.completeAttempt.mockResolvedValueOnce({ kind: 'completed', change_due_minor: 2_500 });
    const outcome = await performRecoveryAction(bridge, complete(), 'ap-1', {
      ...NO_EXTRAS,
      cash: '125',
    });
    expect(bridge.completeAttempt).toHaveBeenCalledWith({
      payment_attempt_id: 'attempt-1',
      approval_id: 'ap-1',
      cash_received_minor: 12_500,
    });
    expect(outcome).toEqual({
      ok: true,
      message: `${RECOVERY_COPY.completed} ${RECOVERY_COPY.change}: ${formatCheckoutMoney(2_500)}`,
    });
  });

  it('sends no cash for a fully tendered attempt and names no change', async () => {
    const bridge = fakeRecoveryBridge();
    const outcome = await performRecoveryAction(bridge, complete({ remaining_minor: 0 }), 'ap-1', {
      ...NO_EXTRAS,
      cash: '50',
    });
    expect(bridge.completeAttempt).toHaveBeenCalledWith({
      payment_attempt_id: 'attempt-1',
      approval_id: 'ap-1',
    });
    expect(outcome).toEqual({ ok: true, message: RECOVERY_COPY.completed });
  });

  it('passes a refusal reason through', async () => {
    const bridge = fakeRecoveryBridge();
    bridge.completeAttempt.mockResolvedValueOnce({ kind: 'refused', reason: 'cash_insufficient' });
    await expect(
      performRecoveryAction(bridge, complete(), 'ap-1', { ...NO_EXTRAS, cash: '100' }),
    ).resolves.toEqual({ ok: false, reason: 'cash_insufficient' });
  });
});

describe('performRecoveryAction — cancel attempt', () => {
  it('sends each confirmation only for live tender', async () => {
    const bridge = fakeRecoveryBridge();
    const extras = { ...NO_EXTRAS, cashReturned: true, cardVoided: true };
    await performRecoveryAction(bridge, cancelAttempt({ card_minor: 0 }), 'ap-1', extras);
    expect(bridge.cancelAttempt).toHaveBeenLastCalledWith({
      payment_attempt_id: 'attempt-1',
      approval_id: 'ap-1',
      cash_returned_confirmed: true,
    });
    await performRecoveryAction(
      bridge,
      cancelAttempt({ cash_minor: 0, card_minor: 7_000 }),
      'ap-2',
      extras,
    );
    expect(bridge.cancelAttempt).toHaveBeenLastCalledWith({
      payment_attempt_id: 'attempt-1',
      approval_id: 'ap-2',
      card_void_confirmed_on_terminal: true,
    });
  });

  it('answers the cancelled message, or the refusal', async () => {
    const bridge = fakeRecoveryBridge();
    await expect(
      performRecoveryAction(bridge, cancelAttempt(), 'ap-1', NO_EXTRAS),
    ).resolves.toEqual({ ok: true, message: RECOVERY_COPY.cancelledPayment });
    bridge.cancelAttempt.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'confirmation_required',
    });
    await expect(
      performRecoveryAction(bridge, cancelAttempt(), 'ap-1', NO_EXTRAS),
    ).resolves.toEqual({ ok: false, reason: 'confirmation_required' });
  });
});

describe('performRecoveryAction — cancel held cart', () => {
  it('sends the cart and the approval only', async () => {
    const bridge = fakeRecoveryBridge();
    await expect(performRecoveryAction(bridge, cancelCart, 'ap-1', NO_EXTRAS)).resolves.toEqual({
      ok: true,
      message: RECOVERY_COPY.cancelledSale,
    });
    expect(bridge.cancelHeldCart).toHaveBeenCalledWith({
      cart_id: 'cart-held-1',
      approval_id: 'ap-1',
    });
    bridge.cancelHeldCart.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_stale' });
    await expect(performRecoveryAction(bridge, cancelCart, 'ap-1', NO_EXTRAS)).resolves.toEqual({
      ok: false,
      reason: 'approval_stale',
    });
  });
});
