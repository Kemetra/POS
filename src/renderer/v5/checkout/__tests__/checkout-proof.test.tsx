/**
 * RT-243 W1-C — the DEV-only Checkout harness (`#/dev/checkout-proof`).
 *
 * The acceptance asks for every payment state to be reachable in the harness.
 * These tests drive the harness itself: its query parsing, its presets (the
 * remount states F1 cares about), and its in-memory stand-in for main's payment
 * projection. The stand-in is presentation scaffolding, not financial
 * evidence; what is pinned here is that it behaves like the projection the
 * surface reads (apply records a line, read returns it, confirm refuses an
 * under-tendered attempt, cancel reverses every line).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';

import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { usePaymentStore } from '../../../stores/payment-store';
import {
  CheckoutProof,
  makeBridge,
  presetLines,
  readParams,
  resetCheckoutProofForTests,
} from '../dev/CheckoutProof';

function at(hash: string): void {
  window.location.hash = hash;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  resetCheckoutProofForTests();
  at('');
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
});

describe('readParams', () => {
  it('defaults to 10 lines, no banner, no preset', () => {
    at('#/dev/checkout-proof');
    expect(readParams()).toEqual({ lines: 10, banner: false, preset: 'none' });
  });

  it('reads lines, banner and preset after the hash', () => {
    at('#/dev/checkout-proof?lines=23&banner=1&preset=change');
    expect(readParams()).toEqual({ lines: 23, banner: true, preset: 'change' });
  });

  it('falls back on a bad line count and caps a large one', () => {
    at('#/dev/checkout-proof?lines=abc');
    expect(readParams().lines).toBe(10);
    at('#/dev/checkout-proof?lines=500');
    expect(readParams().lines).toBe(60);
  });
});

describe('presetLines — the states a remount finds (RT-243 F1)', () => {
  const SUBTOTAL = 24_301;

  it.each([
    ['none', []],
    ['partial', [['cash', 12_150, 0]]],
    ['exact', [['cash', SUBTOTAL, 0]]],
    ['change', [['cash', 30_000, 30_000 - SUBTOTAL]]],
    ['card', [['external_card_terminal', SUBTOTAL, 0]]],
    [
      'mixed',
      [
        ['external_card_terminal', 12_150, 0],
        ['cash', SUBTOTAL - 12_150, 0],
      ],
    ],
  ] as const)('%s', (preset, expected) => {
    const lines = presetLines(preset, SUBTOTAL).map((l) => [
      l.tender_type,
      l.amount_applied_minor,
      l.change_due_minor ?? 0,
    ]);
    expect(lines).toEqual(expected);
  });
});

describe('makeBridge — an in-memory stand-in for the payment projection', () => {
  it('records applied lines and projects them back on read', async () => {
    const { payments, tender } = makeBridge(5_000, []);
    await expect(
      payments.start({
        envelope_handoff_action_id: 'h',
        envelope_cart_id: 'c',
        envelope_subtotal_minor: 5_000,
        envelope_version: 'v1',
        idempotency_key: 'k',
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
    await tender.apply({
      payment_attempt_id: 'a',
      tender_type: 'cash',
      amount_applied_minor: 2_000,
      idempotency_key: 'k1',
    });
    const read = await payments.read({ payment_attempt_id: 'a' });
    expect(read.kind === 'ok' && read.payment_attempt.tender_lines).toHaveLength(1);
    const stream = await payments.subscribe({ payment_attempt_id: 'a' });
    expect(stream.kind).toBe('ok');
  });

  it('gives change only for cash above what is still owed', async () => {
    const { tender } = makeBridge(5_000, []);
    const card = await tender.apply({
      payment_attempt_id: 'a',
      tender_type: 'external_card_terminal',
      amount_applied_minor: 1_000,
      idempotency_key: 'k1',
    });
    expect(card).not.toHaveProperty('change_due_minor');
    const cash = await tender.apply({
      payment_attempt_id: 'a',
      tender_type: 'cash',
      amount_applied_minor: 5_000,
      idempotency_key: 'k2',
    });
    expect(cash).toMatchObject({ kind: 'ok', change_due_minor: 1_000 });
  });

  it('refuses to settle an under-tendered attempt, then settles a covered one', async () => {
    const { payments, tender } = makeBridge(5_000, []);
    const req = { payment_attempt_id: 'a', idempotency_key: 'c' };
    await expect(payments.confirm(req)).resolves.toMatchObject({ kind: 'refused' });
    await tender.apply({
      payment_attempt_id: 'a',
      tender_type: 'cash',
      amount_applied_minor: 5_000,
      idempotency_key: 'k',
    });
    await expect(payments.confirm(req)).resolves.toMatchObject({ kind: 'ok' });
  });

  it('cancel reverses every applied line', async () => {
    const { payments } = makeBridge(5_000, presetLines('mixed', 5_000));
    const res = await payments.cancel({ payment_attempt_id: 'a', idempotency_key: 'x' });
    expect(res.kind === 'ok' && res.reversed_tender_line_ids).toEqual(['seed-1', 'seed-2']);
    const read = await payments.read({ payment_attempt_id: 'a' });
    expect(read.kind === 'ok' && read.payment_attempt.state).toBe('cancelled');
  });

  it('answers the calls the surface does not drive', async () => {
    const { payments, tender } = makeBridge(5_000, []);
    await expect(
      payments.forceFail({ payment_attempt_id: 'a', idempotency_key: 'f' }),
    ).resolves.toMatchObject({ kind: 'ok' });
    await expect(
      tender.reverse({ tender_line_id: 't', idempotency_key: 'r' }),
    ).resolves.toMatchObject({ kind: 'ok', state: 'reversed' });
    await expect(tender.read({ tender_line_id: 't' })).rejects.toThrow();
  });
});

describe('CheckoutProof — the real Checkout in the real frame', () => {
  it('renders a fresh Checkout with Back offered (preset none)', async () => {
    at('#/dev/checkout-proof?lines=3');
    render(<CheckoutProof />);
    await settle();
    expect(screen.getByTestId('v5-frame')).toHaveAttribute('data-nav', 'slim');
    expect(screen.getByTestId('payment-cart-summary')).toHaveTextContent('الأصناف 3');
    expect(screen.queryByTestId('payment-ledger')).not.toBeInTheDocument();
    const back = screen.getByTestId('payment-surface-back');
    expect(back).toBeEnabled();
    // The harness's Back always refuses (no Sale to return to): the surface says so.
    await act(async () => {
      fireEvent.click(back);
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByTestId('payment-surface')).toBeInTheDocument();
  });

  it('a seeded mixed tender shows as recorded money with a frame banner (remount state)', async () => {
    at('#/dev/checkout-proof?lines=2&banner=1&preset=mixed');
    render(<CheckoutProof />);
    await settle();
    expect(screen.getByTestId('v5-frame-notices')).toHaveTextContent('لا توجد وردية مفتوحة');
    const ledger = screen.getByTestId('payment-ledger');
    expect(within(ledger).getAllByTestId('payment-ledger-line')).toHaveLength(2);
    expect(screen.getByTestId('payment-surface-amount-due')).toHaveTextContent('0.00 EGP');
    expect(screen.getByTestId('payment-surface-back')).toBeDisabled();
  });

  it('a cash payment can be taken end to end in the harness', async () => {
    at('#/dev/checkout-proof?lines=1&preset=change');
    render(<CheckoutProof />);
    await settle();
    expect(screen.getByTestId('payment-ledger-change')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('payment-surface-confirm'));
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByTestId('payment-surface-settled')).toHaveTextContent('الباقي للعميل');
  });
});
