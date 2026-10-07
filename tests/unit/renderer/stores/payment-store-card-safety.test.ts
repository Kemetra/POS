import { beforeEach, describe, expect, it } from 'vitest';

import { usePaymentStore } from '../../../../src/renderer/stores/payment-store.js';
import type { PaymentIntentEnvelope } from '../../../../src/shared/cart/handoff-envelope.js';

/**
 * RT-256 — the card-safety record (card lines applied, terminal void required)
 * belongs to the mounted handoff: it survives `clearAttempt` and a re-mount of
 * the same envelope, and never leaks into a different sale.
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

describe('payment store — RT-256 card safety', () => {
  it('starts empty and ignores card facts while no envelope is mounted', () => {
    const store = usePaymentStore.getState();
    expect(store.cardSafety).toBeNull();
    store.recordCardApplied('tl-1');
    store.recordCardApplyAttempted();
    store.markCardVoidRequired();
    expect(usePaymentStore.getState().cardSafety).toBeNull();
  });

  it('records card lines once each and marks the void for the mounted handoff', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    store.recordCardApplied('tl-1');
    store.recordCardApplied('tl-1');
    store.recordCardApplied('tl-2');
    store.markCardVoidRequired();
    expect(usePaymentStore.getState().cardSafety).toEqual({
      handoffId: 'h-1',
      appliedCardLineIds: ['tl-1', 'tl-2'],
      cardApplyAttempted: false,
      voidRequired: true,
    });
  });

  it('records that a card apply was attempted, whatever its outcome', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    store.recordCardApplyAttempted();
    expect(usePaymentStore.getState().cardSafety).toEqual({
      handoffId: 'h-1',
      appliedCardLineIds: [],
      cardApplyAttempted: true,
      voidRequired: false,
    });
  });

  it('survives clearAttempt and a re-mount of the same handoff', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    store.markCardVoidRequired();
    store.clearAttempt();
    store.mount(envelope('h-1'));
    expect(usePaymentStore.getState().cardSafety?.voidRequired).toBe(true);
  });

  it('is dropped when a different handoff is mounted, and on reset', () => {
    const store = usePaymentStore.getState();
    store.mount(envelope('h-1'));
    store.markCardVoidRequired();
    store.mount(envelope('h-2'));
    expect(usePaymentStore.getState().cardSafety).toBeNull();

    store.markCardVoidRequired();
    expect(usePaymentStore.getState().cardSafety?.handoffId).toBe('h-2');
    store.reset();
    expect(usePaymentStore.getState().cardSafety).toBeNull();
  });

  it('a stale record from another handoff is replaced, not extended', () => {
    usePaymentStore.setState({
      envelope: envelope('h-2'),
      cardSafety: {
        handoffId: 'h-1',
        appliedCardLineIds: ['tl-old'],
        cardApplyAttempted: true,
        voidRequired: true,
      },
    });
    usePaymentStore.getState().recordCardApplied('tl-new');
    expect(usePaymentStore.getState().cardSafety).toEqual({
      handoffId: 'h-2',
      appliedCardLineIds: ['tl-new'],
      cardApplyAttempted: false,
      voidRequired: false,
    });
  });
});
