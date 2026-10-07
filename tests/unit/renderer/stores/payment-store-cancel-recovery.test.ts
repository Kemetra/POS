import { beforeEach, describe, expect, it } from 'vitest';

import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';

/**
 * RT-298 — the cancel recovery record (idempotency key + hold) belongs to the
 * mounted handoff's attempt: it survives a re-mount of the same envelope and
 * never leaks into a different sale.
 */

function envelope(handoffId: string): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    handoff_action_id: handoffId,
    cart_id: 'cart-1',
    tenant_id: 't-1',
    branch_id: 'b-1',
    terminal_id: 'term-1',
    operator_session_id: 'sess-1',
    owning_operator_id: 'op-1',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: 1500,
    created_at: '2026-10-07T12:00:00.000Z',
  };
}

beforeEach(() => {
  usePaymentStore.getState().reset();
});

describe('payment store — RT-298 cancel recovery', () => {
  it('mints one key per attempt and returns it on every retry', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    const first = store.cancelKeyFor('pa-1');
    expect(usePaymentStore.getState().cancelKeyFor('pa-1')).toBe(first);
    expect(usePaymentStore.getState().cancelRecovery).toEqual({
      handoffId: 'h-1',
      attemptId: 'pa-1',
      key: first,
      hold: 'none',
    });
  });

  it('a different attempt gets a new key', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    const first = store.cancelKeyFor('pa-1');
    expect(usePaymentStore.getState().cancelKeyFor('pa-2')).not.toBe(first);
  });

  it('records nothing while no envelope is mounted, but still returns a key', () => {
    const key = usePaymentStore.getState().cancelKeyFor('pa-1');
    expect(key).toEqual(expect.any(String));
    expect(usePaymentStore.getState().cancelRecovery).toBeNull();
  });

  it('sets a hold only on a recorded cancel, and clears it on demand', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    store.setCancelHold('unconfirmed');
    expect(usePaymentStore.getState().cancelRecovery).toBeNull();

    store.cancelKeyFor('pa-1');
    usePaymentStore.getState().setCancelHold('unconfirmed');
    expect(usePaymentStore.getState().cancelRecovery?.hold).toBe('unconfirmed');

    usePaymentStore.getState().clearCancelRecovery();
    expect(usePaymentStore.getState().cancelRecovery).toBeNull();
  });

  it('survives clearAttempt and a re-mount of the same handoff', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    store.cancelKeyFor('pa-1');
    usePaymentStore.getState().setCancelHold('live_tender');
    usePaymentStore.getState().clearAttempt();
    usePaymentStore.getState().mount(envelope('h-1'));
    expect(usePaymentStore.getState().cancelRecovery?.hold).toBe('live_tender');
  });

  it('is dropped when a different handoff is mounted, and on reset', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    store.cancelKeyFor('pa-1');
    usePaymentStore.getState().mount(envelope('h-2'));
    expect(usePaymentStore.getState().cancelRecovery).toBeNull();

    usePaymentStore.getState().cancelKeyFor('pa-2');
    usePaymentStore.getState().reset();
    expect(usePaymentStore.getState().cancelRecovery).toBeNull();
  });
});
