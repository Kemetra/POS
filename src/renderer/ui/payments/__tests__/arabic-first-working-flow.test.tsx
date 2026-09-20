/**
 * 022 US3 T076 — RED: zero English-only operator-facing strings across the
 * WORKING (pre-settlement) tender flow.
 *
 * Covers FR-19 / SC-4 for: PaymentCartSummary, TenderSelection, CashEntry,
 * AmountPad, VoucherEntry, ExternalCardTerminalEntry, MoneyRoll.
 *
 * WHY THIS TEST SCANS ATTRIBUTES, NOT JUST TEXT NODES
 * ---------------------------------------------------
 * Two classes of English string are invisible to a rendered-text scan, and a
 * test written over `textContent` alone goes green while an operator still
 * reads English (US3-HANDOFF.md §5):
 *
 *   1. AT-only `aria-label`s — no visible text at all, but they are the
 *      operator-facing output for screen-reader users. Translating only the
 *      visible copy leaves the surface English-only in assistive technology
 *      while *looking* fully Arabic.
 *   2. `placeholder` — VISIBLE on screen, yet still an attribute rather than a
 *      text node. A sighted operator reads it; a text scan does not.
 *
 * So the assertion runs over operator-facing ATTRIBUTES (`aria-label`,
 * `aria-describedby` resolved to its target, `title`, `placeholder`) in
 * addition to rendered text.
 *
 * KNOWN LIMIT — BRANCH COVERAGE, NOT STRING COVERAGE
 * --------------------------------------------------
 * These per-component renders exercise each surface in its DEFAULT state. Copy
 * that only renders inside a conditional branch — refusal banners, empty
 * states, the Slice-1 (bridge === null) fallback — is NOT reached by them, and
 * therefore not scanned.
 *
 * That gap is not theoretical: three sets of English strings were found this
 * way rather than by this file's sweep — PaymentSurface's Slice-1 status
 * banner, its start/cancel/confirm refusal copy, and the entry surfaces'
 * apply-refusal copy. Two were surfaced by the T075 split-tender test and one
 * by a full-suite run, not here.
 *
 * So: an Arabic-first assertion is only as complete as the STATES it renders.
 * A surface added to the list below must have its refusal and fallback states
 * driven deliberately, or its English will pass unseen. The Slice-1 banner case
 * at the bottom of this file is the worked example.
 *
 * FORMAT TOKENS ARE A DELIBERATE EXEMPTION, NOT AN OMISSION
 * ---------------------------------------------------------
 * `VCH-000` and `T1A2B3` are format hints for codes that are themselves Latin
 * (`^[A-Z0-9]{0,6}$` is the real constraint on the external reference). A
 * Latin format token is the correct thing to show for a Latin-alphabet code, so
 * the token itself stays — but any English *prose* wrapping it (`e.g. …`) is
 * copy and must be translated. `ALLOWED_FORMAT_TOKENS` records that judgement
 * explicitly so the exemption is reviewable rather than silent.
 */

import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import { AmountPad } from '../AmountPad.js';
import { CashEntry } from '../CashEntry.js';
import { ExternalCardTerminalEntry } from '../ExternalCardTerminalEntry.js';
import { MoneyRoll } from '../MoneyRoll.js';
import { PaymentCartSummary } from '../PaymentCartSummary.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';
import { TenderSelection } from '../TenderSelection.js';
import { VoucherEntry } from '../VoucherEntry.js';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEnvelope(subtotalMinor = 5000): PaymentIntentEnvelope {
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
    subtotal_minor: subtotalMinor,
    created_at: '2026-06-21T00:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

// ---------------------------------------------------------------------------
// The Arabic-first assertion
// ---------------------------------------------------------------------------

/**
 * Latin format tokens that are legitimately NOT translatable copy. Each is the
 * shape of a code that is itself Latin/numeric, so rendering it in Arabic would
 * misinform the operator about what to type. Reviewed and kept deliberately.
 *
 * This list is CLOSED. Adding to it is a copy decision that needs its own
 * justification — it is not a place to park an untranslated string.
 */
const ALLOWED_FORMAT_TOKENS: readonly string[] = ['VCH-000', 'T1A2B3'];

/** Operator-facing attributes that carry text but are not text nodes. */
const OPERATOR_FACING_ATTRIBUTES: readonly string[] = ['aria-label', 'title', 'placeholder'];

/**
 * A run of >=2 Latin letters is treated as English prose. Single letters and
 * digits are not: currency/quantity glyphs (`×`, `x`) and Latin numerals are
 * required elsewhere by FR-21 (money stays LTR mono), so flagging them would
 * contradict a different rule.
 *
 * Abbreviations punctuated between single letters (`e.g.`, `i.e.`) are English
 * prose but slip under a >=2-letter run, so they are matched explicitly. Found
 * by the self-check below: stripping the `T1A2B3` format token out of
 * `e.g. T1A2B3` left `e.g.`, which the letter-run rule alone did NOT flag —
 * a false negative that would have shipped an English placeholder while the
 * suite went green.
 */
const LATIN_PROSE = /[A-Za-z]{2,}|\b[A-Za-z]\.[A-Za-z]\./;

function stripAllowedTokens(value: string): string {
  return ALLOWED_FORMAT_TOKENS.reduce((acc, token) => acc.split(token).join(' '), value);
}

/**
 * Collect every operator-facing string in the rendered tree: text nodes plus
 * the operator-facing attributes. Returns `[where, what]` pairs so a failure
 * names the exact offending node instead of just saying "English found".
 */
function collectOperatorFacingStrings(root: HTMLElement): [string, string][] {
  const found: [string, string][] = [];

  // 1. Text nodes.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const text = node.textContent ?? '';
    if (text.trim() !== '') {
      const owner = node.parentElement;
      const where =
        owner === null
          ? 'text'
          : `<${owner.tagName.toLowerCase()}${
              owner.className === '' ? '' : ` class="${owner.className}"`
            }>`;
      found.push([where, text.trim()]);
    }
    node = walker.nextNode();
  }

  // 2. Operator-facing attributes on every element, including the root itself.
  const elements: HTMLElement[] = [root, ...Array.from(root.querySelectorAll('*'))].filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
  for (const el of elements) {
    for (const attr of OPERATOR_FACING_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value !== null && value.trim() !== '') {
        found.push([`<${el.tagName.toLowerCase()} ${attr}>`, value.trim()]);
      }
    }
    // aria-describedby points at another node; its TEXT is operator-facing too.
    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy !== null) {
      for (const id of describedBy.split(/\s+/)) {
        const target = root.querySelector(`#${CSS.escape(id)}`);
        const text = target === null ? '' : target.textContent.trim();
        if (text !== '') {
          found.push([`<${el.tagName.toLowerCase()} aria-describedby=${id}>`, text]);
        }
      }
    }
  }

  return found;
}

/**
 * Assert no operator-facing string is English-only.
 *
 * A string passes when it contains Arabic. A bilingual string (Arabic + Latin,
 * e.g. `نقدي — Cash`) passes: it is not English-ONLY, and the requirement is
 * Arabic-first, not Arabic-exclusive.
 */
function expectNoEnglishOnlyStrings(root: HTMLElement, surface: string): void {
  const offenders = collectOperatorFacingStrings(root)
    .map(([where, raw]): [string, string] => [where, stripAllowedTokens(raw)])
    .filter(([, value]) => LATIN_PROSE.test(value))
    .filter(([, value]) => !/[؀-ۿ]/.test(value));

  expect(
    offenders,
    `${surface}: English-only operator-facing string(s) found — ` +
      `${JSON.stringify(offenders)}. Every operator-facing string (text, ` +
      `aria-label, title, placeholder, aria-describedby target) must carry ` +
      `Arabic (FR-19 / SC-4).`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Per-surface assertions across the working (pre-settlement) tender flow
// ---------------------------------------------------------------------------

describe('022 US3 T076 — Arabic-first working tender flow (FR-19 / SC-4)', () => {
  it('PaymentCartSummary carries no English-only operator-facing string', () => {
    const { container } = render(<PaymentCartSummary envelope={makeEnvelope()} />);
    expectNoEnglishOnlyStrings(container, 'PaymentCartSummary');
  });

  it('TenderSelection carries no English-only operator-facing string', () => {
    const { container } = render(
      <TenderSelection envelope={makeEnvelope()} onTenderSelect={vi.fn()} />,
    );
    expectNoEnglishOnlyStrings(container, 'TenderSelection');
  });

  it('CashEntry carries no English-only operator-facing string', () => {
    const { container } = render(<CashEntry remainingBalanceMinor={5000} />);
    expectNoEnglishOnlyStrings(container, 'CashEntry');
  });

  it('AmountPad carries no English-only operator-facing string', () => {
    const { container } = render(<AmountPad valueMinor={0} onChange={vi.fn()} totalMinor={5000} />);
    expectNoEnglishOnlyStrings(container, 'AmountPad');
  });

  it('VoucherEntry carries no English-only operator-facing string', () => {
    const { container } = render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-001" tenderApply={vi.fn()} />,
    );
    expectNoEnglishOnlyStrings(container, 'VoucherEntry');
  });

  it('ExternalCardTerminalEntry carries no English-only operator-facing string', () => {
    const { container } = render(<ExternalCardTerminalEntry remainingBalanceMinor={5000} />);
    expectNoEnglishOnlyStrings(container, 'ExternalCardTerminalEntry');
  });

  it('MoneyRoll carries no English-only operator-facing string', () => {
    const { container } = render(<MoneyRoll valueMinor={1500} />);
    expectNoEnglishOnlyStrings(container, 'MoneyRoll');
  });

  /**
   * PaymentSurface's Slice-1 (bridge === null) status banner.
   *
   * Found by the T075 split-tender test, NOT by this file's original sweep:
   * these three strings ('Cash selected' / 'Card terminal selected' /
   * 'Voucher selected', PaymentSurface.tsx:507-510) live in a
   * `role="status" aria-live="polite"` live region that only renders when no
   * bridge is present. Rendering each component standalone never reaches that
   * branch, so a per-component sweep cannot see them.
   *
   * The lesson is about COVERAGE, not the collector: an Arabic-first assertion
   * is only as complete as the states it actually renders. Conditional branches
   * need to be driven deliberately.
   */
  it('PaymentSurface Slice-1 status banner carries no English-only string', async () => {
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

    // No `_testBridge` — this is the Slice-1 (bridge === null) branch, the only
    // state in which the status banner renders.
    render(<PaymentSurface />);
    await act(async () => {
      screen.getByTestId('tender-cash').click();
      await Promise.resolve();
    });
    const banner = screen.getByTestId('payment-surface-tender-selected');
    expect(banner).toBeInTheDocument();

    // Scoped to the banner, NOT the whole container, on purpose.
    //
    // Scanning the container also sweeps `<OperatorBadge>`, whose role string
    // comes from the SHARED `roleDisplayName` (shared/operator/role.ts) and
    // renders English ("Cashier"). That is a real FR-19 gap, but it belongs to
    // the shell's role-indicator region (003 FR-020) and is visible on every
    // screen — not to US3, which is scoped to the checkout surfaces and to copy
    // only. Translating shared vocabulary from here would widen this slice into
    // components with their own tests and their own visual acceptance.
    //
    // Recorded rather than silently fixed or silently dropped.
    expectNoEnglishOnlyStrings(banner, 'PaymentSurface (Slice-1 status banner)');

    useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
    usePaymentStore.getState().reset();
    useFeatureFlagsStore.getState().reset();
  });
});

// ---------------------------------------------------------------------------
// Guard: the assertion must actually be capable of catching each gap class.
//
// Without these, a bug in the collector (e.g. forgetting attributes) would make
// every test above pass vacuously — the exact failure mode US3-HANDOFF.md §5
// warns about: "A test written literally to the old wording goes green while a
// sighted operator still reads English."
// ---------------------------------------------------------------------------

describe('T076 assertion self-check — detects each class of English gap', () => {
  it('detects an English text node', () => {
    const el = document.createElement('div');
    el.innerHTML = '<h3>Order summary</h3>';
    expect(() => {
      expectNoEnglishOnlyStrings(el, 'fixture');
    }).toThrow(/Order summary/);
  });

  it('detects an AT-only English aria-label with no visible text', () => {
    const el = document.createElement('div');
    el.innerHTML = '<ol aria-label="Cart items"></ol>';
    expect(() => {
      expectNoEnglishOnlyStrings(el, 'fixture');
    }).toThrow(/Cart items/);
  });

  it('detects an English placeholder (visible, but not a text node)', () => {
    const el = document.createElement('div');
    el.innerHTML = '<input placeholder="e.g. T1A2B3" />';
    expect(() => {
      expectNoEnglishOnlyStrings(el, 'fixture');
    }).toThrow(/e\.g\./);
  });

  it('accepts a bare Latin format token with no English prose around it', () => {
    const el = document.createElement('div');
    el.innerHTML = '<input placeholder="VCH-000" />';
    expect(() => {
      expectNoEnglishOnlyStrings(el, 'fixture');
    }).not.toThrow();
  });

  it('accepts a bilingual string (Arabic + Latin)', () => {
    const el = document.createElement('div');
    el.innerHTML = '<span aria-label="نقدي — Cash">نقدي</span>';
    expect(() => {
      expectNoEnglishOnlyStrings(el, 'fixture');
    }).not.toThrow();
  });
});
