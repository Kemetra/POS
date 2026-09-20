/**
 * 006-payments-tender Wave 5c — <VoucherEntry> F-A4B-003 refusal-copy
 * enforcement test (RED).
 *
 * Asserts the §A4-B reviewer decision recorded in
 * `specs/006-payments-tender/reviews/a4b-vouchers-bridge-brief.md` §6,
 * finding F-A4B-003:
 *
 *   ALL EIGHT voucher refusal reasons map to the SAME generic renderer
 *   copy string. The structured `refusal.reason` MUST NEVER enter the
 *   DOM — an attacker who can interact with the POS surface MUST NOT
 *   be able to enumerate voucher validity, balance, or holder
 *   existence by probing codes and reading the rendered response.
 *
 * The 8 reasons (closed enum, from contracts/bridge-api.md
 * §"vouchers.validate" + spec FR-006 + scripts/openapi-snapshot.json
 * POS V-A error.code description):
 *   - voucher_not_found
 *   - voucher_expired
 *   - voucher_cancelled
 *   - voucher_already_redeemed
 *   - voucher_tenant_mismatch
 *   - voucher_branch_mismatch
 *   - non_cash_overpayment_refused
 *   - validation_failure
 *
 * Additional refusal reasons that may surface on the wider TenderApply
 * envelope (no_session / role_denied / attempt_terminal /
 * idempotency_payload_mismatch / wrong_owner / invalid_input /
 * tenant_isolation) MUST also collapse to the same generic copy — the
 * renderer treats EVERY non-ok response identically.
 *
 * A rejected bridge promise (IPC error / main crash / timeout) MUST
 * ALSO collapse to the same copy — no stuck-applying state, no error
 * details in the DOM.
 *
 * **Wave 5c — TDD RED.**
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { VoucherEntry } from '../../../../src/renderer/ui/payments/VoucherEntry.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../src/shared/bridge-api.js';
import type { RefusalReason } from '../../../../src/shared/payments/types.js';

afterEach(() => {
  cleanup();
});

const GENERIC_VOUCHER_REFUSAL_COPY = 'تعذّر استخدام هذه القسيمة حالياً.';

// The 8 voucher-specific refusal reasons enumerated in the contract.
const VOUCHER_REFUSAL_REASONS = [
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
  'non_cash_overpayment_refused',
  'validation_failure',
] as const;

// Additional refusal reasons that the wider TenderApply envelope may
// surface — all must collapse to the same generic copy.
const ENVELOPE_REFUSAL_REASONS = [
  'no_session',
  'role_denied',
  'attempt_terminal',
  'idempotency_payload_mismatch',
  'wrong_owner',
  'invalid_input',
  'tenant_isolation',
] as const;

async function driveRefusal(
  reason: RefusalReason,
): Promise<{ refusedNode: HTMLElement; container: HTMLElement }> {
  const refused: TenderApplyResponse = { kind: 'refused', reason };
  const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
    async () => await Promise.resolve(refused),
  );
  const user = userEvent.setup();
  const { container } = render(
    <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
  );
  await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
  await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
  await user.click(screen.getByTestId('voucher-entry-confirm'));
  await waitFor(() => {
    expect(screen.queryByTestId('voucher-entry-refused')).toBeInTheDocument();
  });
  return { refusedNode: screen.getByTestId('voucher-entry-refused'), container };
}

describe('F-A4B-003 — VoucherEntry refusal-copy enforcement (8 voucher reasons)', () => {
  it.each(VOUCHER_REFUSAL_REASONS)(
    'voucher refusal "%s" renders the SAME generic copy',
    async (reason) => {
      const { refusedNode } = await driveRefusal(reason);
      expect(refusedNode).toHaveTextContent(GENERIC_VOUCHER_REFUSAL_COPY);
      // The structured reason MUST NOT leak to the DOM.
      expect(refusedNode).not.toHaveTextContent(reason);
    },
  );

  it.each(VOUCHER_REFUSAL_REASONS)(
    'voucher refusal "%s" does NOT leak the reason anywhere in the rendered subtree',
    async (reason) => {
      const { container } = await driveRefusal(reason);
      const text = container.textContent;
      // The literal closed-enum string must not appear anywhere in the
      // VoucherEntry rendered output — not just in the refusal banner.
      expect(text).not.toContain(reason);
    },
  );
});

describe('F-A4B-003 — VoucherEntry envelope refusals (collapse to same copy)', () => {
  it.each(ENVELOPE_REFUSAL_REASONS)(
    'envelope refusal "%s" renders the SAME generic copy',
    async (reason) => {
      const { refusedNode } = await driveRefusal(reason);
      expect(refusedNode).toHaveTextContent(GENERIC_VOUCHER_REFUSAL_COPY);
      expect(refusedNode).not.toHaveTextContent(reason);
    },
  );
});

describe('F-A4B-003 — VoucherEntry rejected-promise path', () => {
  it('rejected bridge promise collapses to the SAME generic copy (no stuck-applying state)', async () => {
    const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(() =>
      Promise.reject(new Error('IPC channel closed — sensitive detail')),
    );
    const user = userEvent.setup();
    const { container } = render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-refused')).toBeInTheDocument();
    });
    const refusedNode = screen.getByTestId('voucher-entry-refused');
    expect(refusedNode).toHaveTextContent(GENERIC_VOUCHER_REFUSAL_COPY);
    // The Error message must NOT leak to the DOM anywhere.
    const text = container.textContent;
    expect(text).not.toMatch(/IPC channel closed/i);
    expect(text).not.toMatch(/sensitive detail/i);
    // The applying spinner is gone.
    expect(screen.queryByTestId('voucher-entry-applying')).not.toBeInTheDocument();
  });
});

describe('F-A4B-003 — VoucherEntry refusal banner clears on input edit', () => {
  it('typing in either input clears the refusal banner (so retry is unambiguous)', async () => {
    const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () => await Promise.resolve({ kind: 'refused', reason: 'voucher_not_found' }),
    );
    const user = userEvent.setup();
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'BADCODE');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-refused')).toBeInTheDocument();
    });
    // Cashier edits the voucher code to retry.
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'X');
    expect(screen.queryByTestId('voucher-entry-refused')).not.toBeInTheDocument();
  });
});
