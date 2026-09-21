/**
 * 022 US3 / Phase C — ONE authoritative amount-due presentation.
 *
 * ── THE DEFECT THIS LOCKS OUT ─────────────────────────────────────────────
 *
 * `PaymentSurface` owns the amount due. It renders it as
 * `.payment-surface__amount-value` at `--font-size-4xl` (44px/700) — the
 * dominant numeric on the surface, per spec FR-16 and the approved design
 * handoff ("the amount due is the dominant numeric on the surface").
 *
 * Each of the three tender ENTRY components also rendered its own
 * `.amount-due-card` — a POS v3.5 prototype structure carrying the same value
 * at 2rem (32px). Because the entry component mounts INSIDE
 * `.payment-surface__methods`, the live checkout screen showed the amount due
 * TWICE, at two sizes, in two visual languages, with two different labels
 * (`المبلغ المستحق` vs the bilingual `المطلوب دفعه (Amount due)`).
 *
 * Two competing presentations of the same number is not a hierarchy. It
 * structurally defeats FR-16: a "dominant" numeric is not dominant when an
 * equally-prominent copy of it sits directly below.
 *
 * ── RELATIONSHIP TO `tender-surface-recompose.test.tsx` ───────────────────
 *
 * That file previously asserted each entry component renders an
 * `.amount-due-card`. Those assertions encoded the v3.5 recompose requirement,
 * which FR-16 + the v4 handoff SUPERSEDE. They are retargeted, not deleted —
 * this file now holds the corrected, and strictly STRONGER, invariant: a global
 * "exactly one" count rather than a local "is present".
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED ─────────────────────────────────────
 *
 * Nothing here touches amount calculation, tender application, settlement,
 * split-tender flow or rounding. `remainingBalanceMinor` still arrives from the
 * engine and is still rendered — this is about how many times, and by whom.
 */

import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentsBridgeAPI, TenderBridgeAPI } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';
import { CashEntry } from '../CashEntry.js';
import { VoucherEntry } from '../VoucherEntry.js';
import { ExternalCardTerminalEntry } from '../ExternalCardTerminalEntry.js';

const SUBTOTAL_MINOR = 5000;

function makeEnvelope(): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [
      {
        line_id: 'line-001',
        item_ref: 'item-001',
        display_name: 'باراسيتامول ٥٠٠ مجم',
        quantity: 2,
        unit_price_minor: 1250,
        line_subtotal_minor: 2500,
        note: null,
        version: 1,
        last_action_id: 'act-001',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: SUBTOTAL_MINOR,
    created_at: '2026-09-19T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

function seedSession(): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'أحمد',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-09-19T08:00:00.000Z',
      },
    },
  });
  usePaymentStore.getState().mount(makeEnvelope());
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, productSearch: true });
}

function makeBridge(): { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI } {
  const attempt = {
    payment_attempt_id: 'pa-001',
    state: 'started',
    envelope_subtotal_minor: SUBTOTAL_MINOR,
    started_at: '2026-09-19T09:59:00.000Z',
    tender_lines: [],
  };
  return {
    payments: {
      start: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' })),
      read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, payment_attempt: attempt })),
      confirm: vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, settled_at: '2026-09-19T10:00:00.000Z' }),
      ),
      cancel: vi.fn(() => Promise.resolve({ kind: 'ok' as const })),
    },
    tender: { apply: vi.fn(() => Promise.resolve({ kind: 'ok' as const })) },
  } as unknown as { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI };
}

beforeEach(seedSession);

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.restoreAllMocks();
});

/** Mount the surface and drive it into the entry phase for `testId`. */
async function mountEntryPhase(testId: string): Promise<void> {
  const bridge = makeBridge();
  render(<PaymentSurface _testBridge={bridge} />);
  await act(async () => {
    screen.getByTestId(testId).click();
    await Promise.resolve();
  });
}

describe('022 Phase C — exactly one amount-due presentation on the live surface', () => {
  it.each([
    ['cash', 'tender-cash'],
    ['external card terminal', 'tender-external-card'],
    ['voucher', 'tender-voucher'],
  ])('renders the amount due exactly once in the %s entry phase', async (_label, testId) => {
    await mountEntryPhase(testId);

    // The surface-owned panel is present and is the ONLY one.
    expect(screen.getByTestId('payment-surface-amount-due')).toBeInTheDocument();

    // The superseded v3.5 duplicate must be gone from the whole tree.
    expect(document.querySelectorAll('.amount-due-card')).toHaveLength(0);
    expect(document.querySelectorAll('.amount-due-card__value')).toHaveLength(0);

    // The bilingual v3.5 label must not reappear anywhere.
    expect(document.body.textContent).not.toContain('المطلوب دفعه');
  });

  it('keeps the surface amount-due as the single dominant numeric while a tender is selected', async () => {
    await mountEntryPhase('tender-cash');

    const value = screen.getByTestId('payment-surface-amount-due');
    expect(value).toHaveClass('payment-surface__amount-value');
    // Money stays LTR-isolated (D-006) — unchanged by this cleanup.
    expect(value).toHaveAttribute('dir', 'ltr');
  });
});

describe('022 Phase C — entry components no longer own an amount-due panel', () => {
  it('CashEntry renders no amount-due card of its own', () => {
    render(<CashEntry remainingBalanceMinor={5000} />);
    expect(document.querySelectorAll('.amount-due-card')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('المطلوب دفعه');
  });

  it('ExternalCardTerminalEntry renders no amount-due card of its own', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={5000} />);
    expect(document.querySelectorAll('.amount-due-card')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('المطلوب دفعه');
  });

  it('VoucherEntry renders no amount-due card of its own', () => {
    render(
      <VoucherEntry
        remainingBalanceMinor={5000}
        paymentAttemptId="atid-001"
        tenderApply={vi.fn().mockResolvedValue({ kind: 'ok' })}
      />,
    );
    expect(document.querySelectorAll('.amount-due-card')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('المطلوب دفعه');
  });
});

describe('022 Phase C — the engine value is still rendered (no behaviour lost)', () => {
  it('CashEntry still exposes the remaining balance to its own input flow', () => {
    // The value the engine supplies is still USED — the cleanup removed a
    // duplicate PRESENTATION, never the number or any calculation.
    render(<CashEntry remainingBalanceMinor={5000} />);
    expect(screen.getByTestId('cash-entry-amount-input')).toBeInTheDocument();
  });

  it('the surface shows the engine-supplied remaining balance', async () => {
    await mountEntryPhase('tender-cash');
    // 5000 minor → 50.00 major. Asserting the value proves the cleanup did not
    // disturb what PaymentSurface reads from the engine.
    expect(screen.getByTestId('payment-surface-amount-due').textContent).toContain('50.00');
  });
});
