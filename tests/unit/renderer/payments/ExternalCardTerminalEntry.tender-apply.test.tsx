import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';

import { ExternalCardTerminalEntry } from '../../../../src/renderer/ui/payments/ExternalCardTerminalEntry.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../src/shared/bridge-api.js';

/**
 * T151 — ExternalCardTerminalEntry tender.apply wiring (RED → GREEN).
 *
 * Mirrors CashEntry's wiring with the external-card-terminal differences:
 *   - tender_type = 'external_card_terminal'.
 *   - amount_applied_minor MUST equal the remaining balance (FR-010).
 *   - external_reference is optional; if provided, the regex-validated value
 *     is forwarded; if empty, the field is omitted from the request.
 *
 * SECURITY (FR-007 / FR-008 / Constitution §P6):
 *   - No PAN / CVV / track / cardholder data.
 *   - Generic refusal copy on bridge refusal.
 *   - UUID v4 idempotency key, fresh per click.
 */

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(cleanup);

describe('ExternalCardTerminalEntry — tender.apply wiring (T151)', () => {
  it('calls tenderApply with tender_type=external_card_terminal and exact amount', async () => {
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
      <ExternalCardTerminalEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={onApplied}
        onConfirm={vi.fn()}
      />,
    );

    // Default input is exactly the remaining balance.
    await user.click(screen.getByTestId('external-card-confirm'));

    expect(tenderApply).toHaveBeenCalledTimes(1);
    const req = tenderApply.mock.calls[0]?.[0];
    expect(req?.tender_type).toBe('external_card_terminal');
    expect(req?.amount_applied_minor).toBe(500);
    expect(req?.payment_attempt_id).toBe('pa-1');
    expect(req?.idempotency_key).toMatch(UUID_V4_REGEX);
    expect(req?.external_reference).toBeUndefined();
  });

  it('forwards external_reference when provided', async () => {
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
      <ExternalCardTerminalEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await user.type(screen.getByTestId('external-card-reference-input'), 'T1A2B3');
    await user.click(screen.getByTestId('external-card-confirm'));

    const req = tenderApply.mock.calls[0]?.[0];
    expect(req?.external_reference).toBe('T1A2B3');
  });

  it('omits external_reference when empty', async () => {
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
      <ExternalCardTerminalEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('external-card-confirm'));
    const req = tenderApply.mock.calls[0]?.[0];
    expect('external_reference' in (req ?? {})).toBe(false);
  });

  it('renders generic refusal copy on { kind: refused }', async () => {
    const user = userEvent.setup();
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () =>
        await Promise.resolve({
          kind: 'refused',
          reason: 'non_cash_overpayment_refused',
        }),
    );

    render(
      <ExternalCardTerminalEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('external-card-confirm'));

    const bridgeRefusal = await screen.findByTestId('external-card-bridge-refusal');
    expect(bridgeRefusal).toHaveTextContent(/تعذّر تطبيق|يرجى المحاولة/);
    expect(bridgeRefusal.textContent).not.toMatch(/non_cash_overpayment_refused/);
  });

  it('does not call tenderApply when the input is over the remaining balance', async () => {
    const user = userEvent.setup();
    const tenderApply = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>();

    render(
      <ExternalCardTerminalEntry
        remainingBalanceMinor={500}
        paymentAttemptId="pa-1"
        tenderApply={tenderApply}
        onApplied={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const input = screen.getByTestId('external-card-amount-input');
    await user.clear(input);
    await user.type(input, '6.00');
    const button = screen.getByTestId('external-card-confirm');
    expect(button).toBeDisabled();
    await user.click(button);
    expect(tenderApply).not.toHaveBeenCalled();
  });

  it('falls back to onConfirm when tenderApply is omitted (Slice-2 compatibility)', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(<ExternalCardTerminalEntry remainingBalanceMinor={500} onConfirm={onConfirm} />);

    await user.click(screen.getByTestId('external-card-confirm'));

    expect(onConfirm).toHaveBeenCalledWith({
      amountAppliedMinor: 500,
      externalReference: null,
    });
  });
});
