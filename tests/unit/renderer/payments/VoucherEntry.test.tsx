/**
 * 006-payments-tender Wave 5c T290 — <VoucherEntry> happy-path + input
 * validation test (RED).
 *
 * Asserts (FR-006A / FR-017 + contracts/bridge-api.md §"vouchers.*"):
 *
 *   1. Renders with a remaining-balance display, a voucher-code input,
 *      an amount input, and a confirm button.
 *   2. The confirm button is disabled until both inputs are
 *      well-formed (code matches /^[A-Z0-9_-]{3,64}$/; amount is a
 *      positive integer ≤ remainingBalanceMinor).
 *   3. On click with valid inputs, `tenderApply` is called with the
 *      expected request shape — `tender_type: 'internal_voucher'`,
 *      typed voucher_code, integer amount_applied_minor, fresh
 *      idempotency_key (UUID v4).
 *   4. On `kind: 'ok'`, `onApplied` fires with the response.
 *   5. Money is integer minor units only — the parser refuses
 *      decimals / negatives / scientific notation at the keystroke
 *      level (Constitution §P9 / P-II).
 *
 * The refusal-copy enforcement (F-A4B-003) lives in a sibling test
 * file (VoucherEntry.refusal-copy.test.tsx).
 *
 * **Wave 5c — TDD RED.** Forward-references the component.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { VoucherEntry } from '../../../../src/renderer/ui/payments/VoucherEntry.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../src/shared/bridge-api.js';

afterEach(() => {
  cleanup();
});

function makeOkResponse(): Extract<TenderApplyResponse, { kind: 'ok' }> {
  return {
    kind: 'ok',
    tender_line_id: 'tl-voucher-1',
    applied_at: '2026-05-25T14:00:00.000Z',
  };
}

type BridgeFn = (req: TenderApplyRequest) => Promise<TenderApplyResponse>;

function makeBridge(response: TenderApplyResponse): {
  bridge: BridgeFn;
  spy: ReturnType<typeof vi.fn<BridgeFn>>;
} {
  const spy = vi.fn<BridgeFn>(async () => await Promise.resolve(response));
  return { bridge: spy, spy };
}

describe('T290 — VoucherEntry happy path', () => {
  it('renders both inputs and a confirm button', () => {
    const { bridge } = makeBridge(makeOkResponse());
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    /*
     * RETARGETED by 022 Phase C. The remaining-balance display assertion is
     * dropped HERE because this test renders VoucherEntry standalone, with no
     * PaymentSurface above it — and the amount due is now owned solely by the
     * surface (FR-16). The value's presence is asserted where it is actually
     * rendered, in `PaymentSurface.voucher.test.tsx` and
     * `single-amount-due.test.tsx`. The remaining assertions — the component's
     * own inputs and confirm affordance — are unchanged.
     */
    expect(screen.getByTestId('voucher-entry-code-input')).toBeInTheDocument();
    expect(screen.getByTestId('voucher-entry-amount-input')).toBeInTheDocument();
    expect(screen.getByTestId('voucher-entry-confirm')).toBeInTheDocument();
  });

  it('confirm button is disabled until BOTH inputs are well-formed', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge(makeOkResponse());
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    const confirm = screen.getByTestId('voucher-entry-confirm');
    expect(confirm).toBeDisabled();
    // Code only → still disabled (no amount).
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    expect(confirm).toBeDisabled();
    // Amount only (clear code, type amount) → still disabled.
    await user.clear(screen.getByTestId('voucher-entry-code-input'));
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '10.00');
    expect(confirm).toBeDisabled();
    // Both well-formed → enabled.
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    expect(confirm).not.toBeDisabled();
  });

  it('calls tenderApply with the expected TenderApplyRequest shape on confirm', async () => {
    const user = userEvent.setup();
    const { bridge, spy } = makeBridge(makeOkResponse());
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-42" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const call = spy.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      payment_attempt_id: 'pa-42',
      tender_type: 'internal_voucher',
      amount_applied_minor: 1500,
      voucher_code: 'VOUCHER10',
    });
    // idempotency_key is a UUID v4 generated client-side per R-10.
    expect(call?.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('fires onApplied with the ok response on success', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge(makeOkResponse());
    const onApplied = vi.fn();
    render(
      <VoucherEntry
        remainingBalanceMinor={5000}
        paymentAttemptId="pa-1"
        tenderApply={bridge}
        onApplied={onApplied}
      />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledTimes(1);
    });
    expect(onApplied).toHaveBeenCalledWith({
      kind: 'ok',
      tender_line_id: 'tl-voucher-1',
      applied_at: '2026-05-25T14:00:00.000Z',
    });
  });

  it('refuses to enable the confirm button on amount > remaining balance', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge(makeOkResponse());
    render(
      <VoucherEntry remainingBalanceMinor={1000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '50.00'); // > the ¤10.00 balance
    expect(screen.getByTestId('voucher-entry-confirm')).toBeDisabled();
  });

  // NOTE: the amount field now accepts a currency amount (e.g. "15.00"), so a
  // decimal point is VALID and no longer in this refuse-set. The keystroke
  // guard rejects negatives, alphabetic, and "+". Scientific "1e3" is dropped
  // from this set: the guard accepts the leading "1" and rejects the "e3"
  // keystrokes, so the field never holds "1e3" — it holds the valid "1". The
  // guard prevents the malformed string from ever existing rather than refusing
  // it after the fact, so asserting "1e3 → disabled" is no longer meaningful.
  it.each([
    ['negative', '-100'],
    ['alphabetic', 'abc'],
    ['empty', ''],
    ['leading +', '+100'],
  ])('refuses to enable confirm on amount with %s (P-II keystroke guard)', async (_label, bad) => {
    const user = userEvent.setup();
    const { bridge } = makeBridge(makeOkResponse());
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    if (bad !== '') {
      await user.type(screen.getByTestId('voucher-entry-amount-input'), bad);
    }
    expect(screen.getByTestId('voucher-entry-confirm')).toBeDisabled();
  });

  it('accepts a 2-decimal currency amount and enables confirm (decimal point now valid)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge(makeOkResponse());
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    // ¤15.00 (1500 minor) ≤ the ¤50.00 (5000 minor) balance → confirm enables.
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    expect(screen.getByTestId('voucher-entry-confirm')).toBeEnabled();
  });

  it.each([
    ['lowercase normalised', 'voucher10', 'VOUCHER10'],
    ['mixed case normalised', 'Voucher10', 'VOUCHER10'],
    ['UPPER preserved', 'BIG-CODE-1', 'BIG-CODE-1'],
  ])('normalises voucher code (%s)', async (_label, typed, expected) => {
    const user = userEvent.setup();
    const { bridge, spy } = makeBridge(makeOkResponse());
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), typed);
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '10.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]?.[0]?.voucher_code).toBe(expected);
  });

  it('CR-1: rapid double-click fires tenderApply ONCE (synchronous ref-lock beats render-state lag)', async () => {
    // React's `disabled` flag reflects async state, so two rapid clicks
    // can in principle dispatch two bridge calls before isApplying
    // re-renders. Each submission generates a FRESH UUID v4
    // idempotency_key, so the main-process §P5 dedup cannot collapse
    // the duplicates — they look like distinct intents. The
    // synchronous submitLockRef must absorb the second click.
    let resolveBridge: (r: TenderApplyResponse) => void = () => {};
    const pending = new Promise<TenderApplyResponse>((res) => {
      resolveBridge = res;
    });
    const spy = vi.fn<BridgeFn>(() => pending);
    const user = userEvent.setup();
    render(<VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={spy} />);
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    const confirm = screen.getByTestId('voucher-entry-confirm');
    // Fire two clicks back-to-back without yielding to React.
    await Promise.all([user.click(confirm), user.click(confirm)]);
    // Only ONE bridge call fired, regardless of how many clicks
    // userEvent recorded.
    expect(spy).toHaveBeenCalledTimes(1);
    resolveBridge({
      kind: 'ok',
      tender_line_id: 'tl-1',
      applied_at: '2026-05-25T14:00:00.000Z',
    });
    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-applying')).not.toBeInTheDocument();
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -100],
    ['non-integer', 100.5],
  ])(
    'CR-2: refuses to enable confirm when remainingBalanceMinor is malformed (%s)',
    async (_label, badRemaining) => {
      const user = userEvent.setup();
      const { bridge } = makeBridge(makeOkResponse());
      render(
        <VoucherEntry
          remainingBalanceMinor={badRemaining}
          paymentAttemptId="pa-1"
          tenderApply={bridge}
        />,
      );
      await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
      await user.type(screen.getByTestId('voucher-entry-amount-input'), '1.00');
      expect(screen.getByTestId('voucher-entry-confirm')).toBeDisabled();
    },
  );

  it('confirm button is disabled while the bridge call is in flight', async () => {
    let resolveBridge: (r: TenderApplyResponse) => void = () => {};
    const pending = new Promise<TenderApplyResponse>((res) => {
      resolveBridge = res;
    });
    const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(() => pending);
    const user = userEvent.setup();
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-applying')).toBeInTheDocument();
    });
    expect(screen.getByTestId('voucher-entry-confirm')).toBeDisabled();
    // Resolve and confirm the applying state clears.
    resolveBridge(makeOkResponse());
    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-applying')).not.toBeInTheDocument();
    });
  });
});
