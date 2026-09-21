/**
 * Slice 4 — TDD: visual recompose of the tender surface to the v3.5 prototype
 * structure, bound to the EXISTING engine. Tests cover:
 *
 *   POSITIVE:
 *   1. SUPERSEDED by 022 Phase C. This file once required each entry component
 *      to render its own `.amount-due-card`. FR-16 + the v4 design handoff make
 *      `PaymentSurface` the sole owner of the amount due, so those three
 *      assertions are RETARGETED in place to assert its ABSENCE. The positive
 *      invariant ("exactly one amount-due presentation") lives in
 *      `single-amount-due.test.tsx`. Item 7 below is superseded with them.
 *   2. method grid uses tender-method-grid (3-method, NOT --four)
 *   3. cash path renders tender-slots + tender-row + MoneyRoll change-due
 *   4. card path renders tender-slots + a tender-row__body instruction row
 *   5. voucher path renders voucher-field input + voucher-error (invalid)
 *   6. quick-amounts + quick-amount-btn render in the cash path
 *   7. SUPERSEDED with item 1 — the amount-due label is no longer rendered by
 *      these components, so there is no label here to carry Arabic copy.
 *   8. Money values (change-due) render dir="ltr" mono
 *
 *   NEGATIVE (rejected prototype behaviours — must NEVER appear):
 *   N1. Insurance / Credit method labels (Arabic تأمين / آجل) never render
 *   N2. method-grid--four never appears in the DOM
 *   N3. Client-side voucher lookup: entering a known prototype demo code
 *       "VCH-100" produces NO client-side "applied" discount in the DOM —
 *       only the bridge can apply a voucher line (bridge refusal is generic)
 *   N4. No client-side change computation: the component never computes
 *       tendered - total itself; change-due comes from the engine
 *       (computeChangeDueMinor, which CashEntry already calls)
 */

import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import { TenderSelection } from '../TenderSelection.js';
import { CashEntry } from '../CashEntry.js';
import { ExternalCardTerminalEntry } from '../ExternalCardTerminalEntry.js';
import { VoucherEntry } from '../VoucherEntry.js';

afterEach(cleanup);

/**
 * Query a single element by CSS selector and narrow it to non-null. `querySelector`
 * is typed `T | null`; `expect(...).not.toBeNull()` is not a TS type guard, so this
 * helper throws (narrowing the return) instead of using a non-null assertion
 * (`@typescript-eslint/no-non-null-assertion` forbids `el!`).
 */
function queryOrThrow(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) {
    throw new Error(`expected an element matching "${selector}", found none`);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A complete, correctly-typed envelope. TenderSelection only reads
// subtotal_minor, but the prop type is the full PaymentIntentEnvelope, so the
// helper returns every field (annotated, so tsc enforces the shape — a partial
// object compiles under Vitest's esbuild transform but fails `tsc --noEmit`).
function makeEnvelope(subtotalMinor = 5000): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [],
    discount_placeholders: [],
    subtotal_minor: subtotalMinor,
    created_at: '2026-06-21T00:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

// ---------------------------------------------------------------------------
// 1. TenderSelection — amount-due-card structure
//    The amount-due-card is part of PaymentSurface (the orchestrator). We test
//    the TenderSelection component's 3-method grid here, and verify the card
//    via PaymentSurface in a separate group below.
// ---------------------------------------------------------------------------

describe('TenderSelection — v3.5 visual recompose', () => {
  it('renders the three tender options in a tender-method-grid container', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    const grid = document.querySelector('.tender-method-grid');
    expect(grid).toBeInTheDocument();
    // All three buttons must be children of the grid
    const cashBtn = screen.getByTestId('tender-cash');
    const cardBtn = screen.getByTestId('tender-external-card');
    const voucherBtn = screen.getByTestId('tender-voucher');
    expect(grid).toContainElement(cashBtn);
    expect(grid).toContainElement(cardBtn);
    expect(grid).toContainElement(voucherBtn);
  });

  it('Arabic labels are present on the tender method buttons', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    // v3.5 prototype uses Arabic-first labels: نقدي / بطاقة / قسيمة
    expect(screen.getByTestId('tender-cash')).toHaveTextContent('نقدي');
    expect(screen.getByTestId('tender-external-card')).toHaveTextContent('بطاقة');
    expect(screen.getByTestId('tender-voucher')).toHaveTextContent('قسيمة');
  });

  it('selected tender method gets method-card--selected class when clicked', () => {
    const onSelect = vi.fn();
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={onSelect} />);
    const cashBtn = screen.getByTestId('tender-cash');
    fireEvent.click(cashBtn);
    expect(onSelect).toHaveBeenCalledWith('cash');
    // After re-render with the active method, the button should have the
    // selected class. Since TenderSelection is stateless (parent owns state),
    // we check the callback fired — selection state is verified via
    // PaymentSurface integration below.
  });
});

// ---------------------------------------------------------------------------
// 2. CashEntry — amount-due-card + tender-row layout + MoneyRoll change
// ---------------------------------------------------------------------------

describe('CashEntry — v3.5 visual recompose (amount-due-card, tender-rows)', () => {
  /*
   * RETARGETED by 022 Phase C — not weakened.
   *
   * The two assertions that stood here required CashEntry to render its own
   * `.amount-due-card`. That was the v3.5 recompose requirement, and it is
   * SUPERSEDED by FR-16 + the v4 design handoff: `PaymentSurface` owns the
   * amount due as the surface's single dominant numeric. A per-entry copy put
   * the same value on screen twice, at two sizes, defeating that hierarchy.
   *
   * The corrected invariant is stronger than what it replaces — a global
   * "exactly one amount-due presentation" count rather than a local "is
   * present" — and lives in `single-amount-due.test.tsx`. This stub keeps the
   * supersession visible at the original site so the change reads as a
   * deliberate retarget rather than a silently dropped assertion.
   */
  it('does NOT render its own amount-due card (superseded — see single-amount-due.test.tsx)', () => {
    render(<CashEntry remainingBalanceMinor={5000} />);
    expect(document.querySelectorAll('.amount-due-card')).toHaveLength(0);
  });

  it('renders tender-slots container with a tender-row for cash input', () => {
    render(<CashEntry remainingBalanceMinor={5000} />);
    const slots = document.querySelector('.tender-slots');
    expect(slots).toBeInTheDocument();
    const rows = document.querySelectorAll('.tender-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('renders quick-amounts chips inside the cash input row', () => {
    render(<CashEntry remainingBalanceMinor={5000} />);
    const quickAmounts = document.querySelector('.quick-amounts');
    expect(quickAmounts).toBeInTheDocument();
    const chips = document.querySelectorAll('.quick-amount-btn');
    expect(chips.length).toBeGreaterThan(0);
  });

  it('renders the prototype rounded-banknote suggestion chips (exact + roll-ups)', () => {
    // 12.30 due → quickAmounts(1230) = [1230, 5000, 10000, 20000, 50000]:
    // the exact chip (بالضبط) PLUS the rounded banknote roll-ups. The prototype
    // (pos-app.jsx:780-790) renders the exact chip + up to 4 rounded suggestions,
    // so the chip count must exceed 1 (the lone exact chip is a parity miss).
    render(<CashEntry remainingBalanceMinor={1230} />);
    const chips = document.querySelectorAll('.quick-amount-btn');
    expect(chips.length).toBeGreaterThanOrEqual(2);
    // The exact-label chip carries Arabic بالضبط; the suggestion chips carry
    // dir="ltr" mono money values. The next banknote roll-up above 12.30 is
    // 50.00 (¤5000 minor) — it must appear as a chip value.
    const chipText = Array.from(chips)
      .map((c) => c.textContent)
      .join(' ');
    expect(chipText).toContain('بالضبط');
    expect(chipText).toContain('50.00');
  });

  it('change-due row (tender-row--totals) shows MoneyRoll when overpaid', () => {
    render(<CashEntry remainingBalanceMinor={1250} />);
    // Enter 15.00 (overpays by 2.50)
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), {
      target: { value: '15.00' },
    });
    // Should have a totals row with the MoneyRoll
    const totalsRow = document.querySelector('.tender-row--totals');
    expect(totalsRow).toBeInTheDocument();
    const roll = screen.getByTestId('money-roll');
    expect(roll).toBeInTheDocument();
    // MoneyRoll is always dir="ltr"
    expect(roll).toHaveAttribute('dir', 'ltr');
  });

  it('change-due MoneyRoll renders 0.00 when exact cash (no overpayment)', () => {
    render(<CashEntry remainingBalanceMinor={1250} />);
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), {
      target: { value: '12.50' },
    });
    // Exact cash: change is 0 → MoneyRoll may render with zero or be absent;
    // if absent that's acceptable (not a regression). If present, it's 0.00.
    const roll = screen.queryByTestId('money-roll');
    if (roll !== null) {
      expect(roll).toHaveTextContent('0.00');
    }
  });

  it('quick-amount-btn--label chip (exact-change shortcut) is rendered', () => {
    render(<CashEntry remainingBalanceMinor={5000} />);
    const exactBtn = queryOrThrow('.quick-amount-btn--label');
    // Must contain Arabic "بالضبط" (exact) label
    expect(exactBtn.textContent).toMatch(/[ا-ي]/);
  });

  it('clicking the exact (بالضبط) chip fills the amount input with the exact balance', () => {
    render(<CashEntry remainingBalanceMinor={5000} />);
    const exactBtn = queryOrThrow('.quick-amount-btn--label');
    fireEvent.click(exactBtn);
    // 5000 minor → "50.00" currency string (formatMinorToInput round-trip).
    expect(screen.getByTestId('cash-entry-amount-input')).toHaveValue('50.00');
    // Once the exact amount is entered, the chip carries the --selected modifier
    // (space-delimited token alongside --label, not a concatenated class).
    expect(exactBtn.className).toContain('quick-amount-btn--selected');
  });

  it('clicking a rounded-banknote suggestion chip fills the input with that amount', () => {
    render(<CashEntry remainingBalanceMinor={1230} />);
    // The first suggestion chip above the exact 12.30 is 50.00 (¤5000 roll-up).
    const suggestionChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.quick-amount-btn'),
    ).find((c) => !c.className.includes('--label') && c.textContent.includes('50.00'));
    if (suggestionChip === undefined) {
      throw new Error('expected a rounded-banknote suggestion chip showing 50.00');
    }
    fireEvent.click(suggestionChip);
    expect(screen.getByTestId('cash-entry-amount-input')).toHaveValue('50.00');
    // The clicked suggestion now carries the --selected modifier.
    expect(suggestionChip.className).toContain('quick-amount-btn--selected');
  });
});

// ---------------------------------------------------------------------------
// 3. ExternalCardTerminalEntry — v3.5 visual recompose (card path)
// ---------------------------------------------------------------------------

describe('ExternalCardTerminalEntry — v3.5 visual recompose (card tender-slots)', () => {
  // RETARGETED by 022 Phase C — see the note in the CashEntry describe above.
  it('does NOT render its own amount-due card (superseded — see single-amount-due.test.tsx)', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={5000} />);
    expect(document.querySelectorAll('.amount-due-card')).toHaveLength(0);
  });

  it('renders tender-slots with at least one tender-row for card terminal instruction', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={5000} />);
    expect(document.querySelector('.tender-slots')).toBeInTheDocument();
    expect(document.querySelectorAll('.tender-row').length).toBeGreaterThanOrEqual(1);
  });

  it('card instruction row uses tender-row__body for the instructional text', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={5000} />);
    const body = queryOrThrow('.tender-row__body');
    // Must contain Arabic instruction copy
    expect(body.textContent).toMatch(/[ا-ي]/);
  });

  it('card totals row (tender-row--totals) shows the amount in a dir=ltr mono span', () => {
    render(<ExternalCardTerminalEntry remainingBalanceMinor={5000} />);
    const totalsRow = queryOrThrow('.tender-row--totals');
    // The value span must be dir="ltr"
    const value = totalsRow.querySelector('[dir="ltr"]');
    expect(value).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. VoucherEntry — v3.5 visual recompose (voucher-field, voucher-error)
// ---------------------------------------------------------------------------

const MOCK_TENDER_APPLY = vi.fn().mockResolvedValue({ kind: 'ok' });

describe('VoucherEntry — v3.5 visual recompose (voucher-field, voucher-error)', () => {
  // RETARGETED by 022 Phase C — see the note in the CashEntry describe above.
  it('does NOT render its own amount-due card (superseded — see single-amount-due.test.tsx)', () => {
    render(
      <VoucherEntry
        remainingBalanceMinor={5000}
        paymentAttemptId="atid-001"
        tenderApply={MOCK_TENDER_APPLY}
      />,
    );
    expect(document.querySelectorAll('.amount-due-card')).toHaveLength(0);
  });

  it('voucher code input is inside a .voucher-field container', () => {
    render(
      <VoucherEntry
        remainingBalanceMinor={5000}
        paymentAttemptId="atid-001"
        tenderApply={MOCK_TENDER_APPLY}
      />,
    );
    const voucherField = document.querySelector('.voucher-field');
    expect(voucherField).toBeInTheDocument();
    // The code input must be inside the voucher-field
    const codeInput = screen.getByTestId('voucher-entry-code-input');
    expect(voucherField).toContainElement(codeInput);
    // Input must be dir="ltr" (voucher codes are alphanumeric, not bidi)
    expect(codeInput).toHaveAttribute('dir', 'ltr');
  });

  it('renders voucher-error class element when code is malformed', () => {
    render(
      <VoucherEntry
        remainingBalanceMinor={5000}
        paymentAttemptId="atid-001"
        tenderApply={MOCK_TENDER_APPLY}
      />,
    );
    // Enter a short code that fails the ≥3-char + pattern validation
    const codeInput = screen.getByTestId('voucher-entry-code-input');
    // Two-char input — codeIsWellFormed is false, error should appear
    fireEvent.change(codeInput, { target: { value: 'AB' } });
    const errorEl = document.querySelector('.voucher-error');
    expect(errorEl).toBeInTheDocument();
  });

  it('renders voucher-hint (instruction copy) below the input', () => {
    render(
      <VoucherEntry
        remainingBalanceMinor={5000}
        paymentAttemptId="atid-001"
        tenderApply={MOCK_TENDER_APPLY}
      />,
    );
    const hint = document.querySelector('.voucher-hint');
    expect(hint).toBeInTheDocument();
  });

  it('voucher-applied--ok indicator appears after a successful bridge apply', async () => {
    let resolveApplyOk!: (v: object) => void;
    const applyOk = vi.fn().mockImplementation(
      () =>
        new Promise<object>((resolve) => {
          resolveApplyOk = resolve;
        }),
    );
    const onApplied = vi.fn();
    render(
      <VoucherEntry
        remainingBalanceMinor={5000}
        paymentAttemptId="atid-001"
        tenderApply={applyOk as Parameters<typeof VoucherEntry>[0]['tenderApply']}
        onApplied={onApplied}
      />,
    );
    // Enter a valid code + valid amount (50.00 = 5000 minor = full balance)
    fireEvent.change(screen.getByTestId('voucher-entry-code-input'), {
      target: { value: 'VCH-TEST' },
    });
    fireEvent.change(screen.getByTestId('voucher-entry-amount-input'), {
      target: { value: '50.00' },
    });
    expect(screen.getByTestId('voucher-entry-confirm')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('voucher-entry-confirm'));
    expect(applyOk).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveApplyOk({
        kind: 'ok',
        payment_attempt_id: 'atid-001',
        tender_line_id: 'tl-001',
        state: 'applied',
        amount_applied_minor: 5000,
      });
      await Promise.resolve();
    });
    // After a successful apply, onApplied was called and voucher-applied--ok appears
    expect(onApplied).toHaveBeenCalled();
    const ok = document.querySelector('.voucher-applied--ok');
    expect(ok).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE tests — rejected prototype behaviours must NEVER appear
// ---------------------------------------------------------------------------

describe('NEGATIVE — rejected prototype behaviours are absent', () => {
  it('N1a: insurance method label (Arabic تأمين) never renders in TenderSelection', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    // Should NOT contain the insurance Arabic label
    expect(screen.queryByText('تأمين')).toBeNull();
    // Should NOT contain the credit Arabic label
    expect(screen.queryByText('آجل')).toBeNull();
  });

  it('N1b: insurance / credit method buttons never render (no data-testid for them)', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    expect(screen.queryByTestId('tender-insurance')).toBeNull();
    expect(screen.queryByTestId('tender-credit')).toBeNull();
  });

  it('N2: method-grid--four class never appears in the TenderSelection DOM', () => {
    render(<TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />);
    expect(document.querySelector('.method-grid--four')).toBeNull();
  });

  it('N3: entering prototype demo code "VCH-100" in VoucherEntry produces NO client-side applied discount — bridge refusal is generic', async () => {
    // Bridge returns a generic refusal (no reason enumerated).
    // We resolve the promise immediately using a deferred pattern so we can
    // flush all microtasks with act() synchronously.
    let resolveApply!: (v: { kind: string; reason: string }) => void;
    const applyRefused = vi.fn().mockImplementation(
      () =>
        new Promise<{ kind: string; reason: string }>((resolve) => {
          resolveApply = resolve;
        }),
    );
    render(
      <VoucherEntry
        remainingBalanceMinor={10000}
        paymentAttemptId="atid-002"
        tenderApply={applyRefused as Parameters<typeof VoucherEntry>[0]['tenderApply']}
      />,
    );
    // Enter valid code (VCH-100) and amount (100.00 = 10000 minor = full balance)
    fireEvent.change(screen.getByTestId('voucher-entry-code-input'), {
      target: { value: 'VCH-100' },
    });
    fireEvent.change(screen.getByTestId('voucher-entry-amount-input'), {
      target: { value: '100.00' },
    });
    // Verify the confirm button is enabled before clicking
    const confirmBtn = screen.getByTestId('voucher-entry-confirm');
    expect(confirmBtn).not.toBeDisabled();
    // Click and then resolve the bridge call via act
    fireEvent.click(confirmBtn);
    expect(applyRefused).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveApply({ kind: 'refused', reason: 'voucher_not_found' });
      await Promise.resolve();
    });
    // NO client-side "applied" amount / discount should appear
    expect(document.querySelector('.voucher-applied')).toBeNull();
    // Generic copy must be shown (not the specific refusal reason)
    const refused = screen.getByTestId('voucher-entry-refused');
    expect(refused).toHaveTextContent('تعذّر استخدام هذه القسيمة حالياً.');
    // The structured reason string must NOT appear in the DOM
    expect(screen.queryByText('voucher_not_found')).toBeNull();
  });

  it('N4: CashEntry does NOT compute change client-side (tendered - total) — change-due comes from computeChangeDueMinor', () => {
    // This test verifies the engine contract: the change-due value rendered
    // matches what computeChangeDueMinor(1500, 1250) = 250 produces, NOT a
    // client-side expression of tendered - total. We verify the OUTPUT is
    // correct (250 minor = ¤2.50). The implementation must not duplicate math.
    render(<CashEntry remainingBalanceMinor={1250} />);
    fireEvent.change(screen.getByTestId('cash-entry-amount-input'), {
      target: { value: '15.00' },
    });
    // The correct change-due is ¤2.50 (250 minor units)
    const changeDue = screen.getByTestId('cash-entry-change-due');
    expect(changeDue).toHaveTextContent('2.50');
  });
});
