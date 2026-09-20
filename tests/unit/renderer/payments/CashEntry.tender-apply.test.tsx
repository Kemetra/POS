import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';

import { CashEntry } from '../../../../src/renderer/ui/payments/CashEntry.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../src/shared/bridge-api.js';

/**
 * T151 — CashEntry tender.apply wiring (RED → GREEN).
 *
 * The component accepts an optional `tenderApply` bridge callback. When the
 * cashier confirms a sufficient cash amount and the callback is provided,
 * the component:
 *
 *   1. Generates a fresh UUID v4 idempotency_key on each click (per FR-006B
 *      / R-10). Different clicks → different keys.
 *   2. Builds a `TenderApplyRequest` with tender_type='cash',
 *      amount_applied_minor = the parsed input, and the generated key.
 *   3. Awaits the response. On `{ kind: 'ok', tender_line_id, ... }`,
 *      fires `onApplied(response)`. On `{ kind: 'refused', reason }`,
 *      fires `onRefused(reason)` and renders a generic refusal copy
 *      (the structured reason name never enters the DOM).
 *
 * When `tenderApply` is NOT provided, the component falls back to the
 * Slice-2 behaviour: `onConfirm({amountAppliedMinor, changeDueMinor})`.
 * This preserves test fixtures + Slice-2 callers.
 *
 * SECURITY (FR-006 / FR-006B / FR-017):
 *   - Generic refusal copy at the DOM ("تعذّر تطبيق الدفعة. يرجى المحاولة مرة أخرى.").
 *   - Structured `reason` never appears in the DOM.
 *   - Idempotency key is a UUID v4 (regex-asserted below).
 */

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(cleanup);

describe('CashEntry — tender.apply wiring (T151)', () => {
  it('calls tenderApply with tender_type=cash and the parsed amount when sufficient', async () => {
    const user = userEvent.setup();
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'ok',
          tender_line_id: 'tl-1',
          applied_at: '2026-05-23T12:00:01.000Z',
        }),
    );
    const onApplied = vi.fn();

    render(
      <CashEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={onApplied}
        onConfirm={() => {
          /* unused when tenderApply is provided */
        }}
      />,
    );

    await user.type(screen.getByTestId('cash-entry-amount-input'), '5.00');
    await user.click(screen.getByTestId('cash-entry-confirm'));

    expect(tenderApply).toHaveBeenCalledTimes(1);
    const req = tenderApply.mock.calls[0]?.[0];
    expect(req).toBeDefined();
    expect(req?.tender_type).toBe('cash');
    expect(req?.amount_applied_minor).toBe(500);
    expect(req?.payment_attempt_id).toBe('pa-1');
    expect(req?.idempotency_key).toMatch(UUID_V4_REGEX);
  });

  it('generates a fresh idempotency_key per click (R-10)', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async (req) => {
        seen.push(req.idempotency_key);
        return await Promise.resolve({
          kind: 'refused',
          reason: 'internal_error',
        });
      },
    );

    render(
      <CashEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId('cash-entry-amount-input'), '5.00');
    await user.click(screen.getByTestId('cash-entry-confirm'));
    await user.click(screen.getByTestId('cash-entry-confirm'));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(UUID_V4_REGEX);
    expect(seen[1]).toMatch(UUID_V4_REGEX);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('fires onApplied with the ok response on success', async () => {
    const user = userEvent.setup();
    const okResponse = {
      kind: 'ok' as const,
      tender_line_id: 'tl-1',
      applied_at: '2026-05-23T12:00:01.000Z',
      change_due_minor: 100,
    };
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () => await Promise.resolve(okResponse),
    );
    const onApplied = vi.fn();

    render(
      <CashEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={onApplied}
        onConfirm={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId('cash-entry-amount-input'), '6.00');
    await user.click(screen.getByTestId('cash-entry-confirm'));

    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith(okResponse);
  });

  it('renders generic refusal copy on { kind: refused }', async () => {
    const user = userEvent.setup();
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'refused',
          reason: 'idempotency_payload_mismatch',
        }),
    );

    render(
      <CashEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId('cash-entry-amount-input'), '5.00');
    await user.click(screen.getByTestId('cash-entry-confirm'));

    const bridgeRefusal = await screen.findByTestId('cash-entry-bridge-refusal');
    // Generic copy — the structured reason name never enters the DOM.
    expect(bridgeRefusal).toHaveTextContent(/تعذّر تطبيق|يرجى المحاولة/);
    expect(bridgeRefusal.textContent).not.toMatch(/idempotency_payload_mismatch/);
  });

  it('allows a partial cash apply in bridged mode (split-tender T154)', async () => {
    // T154: in bridged mode, the cashier may apply a partial cash line for
    // less than the remaining balance. The surface then returns to tender
    // selection for the remainder. The settlement invariant is enforced on
    // the main process at payments.confirm time.
    const user = userEvent.setup();
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'ok',
          tender_line_id: 'tl-1',
          applied_at: '2026-05-23T12:00:01.000Z',
        }),
    );

    render(
      <CashEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId('cash-entry-amount-input'), '4.00');
    const button = screen.getByTestId('cash-entry-confirm');
    expect(button).not.toBeDisabled();
    await user.click(button);

    expect(tenderApply).toHaveBeenCalledTimes(1);
    expect(tenderApply.mock.calls[0]?.[0]?.amount_applied_minor).toBe(400);
    // The "amount is not enough" banner does NOT show in bridged mode.
    expect(screen.queryByTestId('cash-entry-refusal')).not.toBeInTheDocument();
  });

  it('rejects an empty / zero input in bridged mode (button disabled)', () => {
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>();

    render(
      <CashEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    // No input yet → button disabled.
    expect(screen.getByTestId('cash-entry-confirm')).toBeDisabled();
    expect(tenderApply).not.toHaveBeenCalled();
  });

  it('falls back to onConfirm when tenderApply is omitted (Slice-2 compatibility)', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(<CashEntry remainingBalanceMinor={500} onConfirm={onConfirm} />);

    await user.type(screen.getByTestId('cash-entry-amount-input'), '5.00');
    await user.click(screen.getByTestId('cash-entry-confirm'));

    expect(onConfirm).toHaveBeenCalledWith({
      amountAppliedMinor: 500,
      changeDueMinor: 0,
    });
  });
});
