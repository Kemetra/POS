import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ManagerAdminSignInForm } from '../ManagerAdminSignInForm.js';
import { PinPad } from '../PinPad.js';
import { RosterList } from '../RosterList.js';
import type { OperatorBridgeAPI, SignInResponse } from '../../../../shared/bridge-api.js';

/**
 * 022 US1 T054 — Arabic-first operator LABELS, and the accessibility
 * properties that make the translation safe.
 *
 * Why this file renders instead of reading source: the two properties that
 * actually matter — that a label is *programmatically associated* with its
 * control, and that the *accessible name* matches the visible text — only
 * exist in a real accessibility tree. A source grep would prove neither.
 *
 * The WCAG 2.5.3 (Label in Name) point is the whole reason the obvious
 * shortcut was rejected: translating visible text while leaving an English
 * `aria-label` behind would keep old tests passing and silently create a
 * visible-text/accessible-name mismatch. Instead the visible labels moved to
 * Arabic, the accessible names follow from them, and the tests that used to
 * query by English copy were re-pointed to stable `data-testid` semantics.
 */

const ARABIC = /[؀-ۿ]/u;
/** Latin letters, ignoring the glyph keys (⌫ ↵) and digits. */
const LATIN_WORD = /[A-Za-z]{2,}/;

function makeBridge(): OperatorBridgeAPI {
  return {
    signIn: vi.fn(() =>
      Promise.resolve({ kind: 'refused', category: 'invalid_input' } as SignInResponse),
    ),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    getCurrentSession: vi.fn(() => Promise.resolve(null)),
    _reportActivity: vi.fn(),
    emitAuditEvent: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    _emitAuditEventSmoke: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    listBranchRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
    confirmTakeover: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
    resetCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    provisionCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    unlockCashier: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    forceCloseShift: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    listStuckShifts: vi.fn(() => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] })),
    dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
  };
}

afterEach(cleanup);

describe('022 T054 (1) — operator-facing primary labels are Arabic-first', () => {
  it('the sign-in form labels and submit action are Arabic', () => {
    render(<ManagerAdminSignInForm operator={makeBridge()} />);
    const identifier = screen.getByTestId('sign-in-identifier');
    const password = screen.getByTestId('sign-in-password');

    // The accessible name is what a screen reader speaks — assert on that,
    // not on the raw markup.
    expect(identifier.getAttribute('aria-label') ?? labelTextFor(identifier)).toMatch(ARABIC);
    expect(password.getAttribute('aria-label') ?? labelTextFor(password)).toMatch(ARABIC);
    expect(screen.getByTestId('sign-in-submit').textContent).toMatch(ARABIC);
  });

  it('the pin-pad group and its glyph keys carry Arabic accessible names', () => {
    render(<PinPad value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    // Two role="group" elements exist: the dot/progress region and the key
    // grid. Assert BOTH are Arabic rather than picking one.
    const groups = screen.getAllByRole('group');
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.getAttribute('aria-label')).toMatch(ARABIC);
    }
    // ⌫ and ↵ render as glyphs, so aria-label IS the only accessible name —
    // there is no visible word to mismatch (2.5.3 does not bind here).
    expect(screen.getByTestId('pin-pad-backspace').getAttribute('aria-label')).toMatch(ARABIC);
    expect(screen.getByTestId('pin-pad-enter').getAttribute('aria-label')).toMatch(ARABIC);
  });

  it('the cashier roster region is named in Arabic', () => {
    render(<RosterList cashiers={[]} onSelect={vi.fn()} />);
    const region = document.querySelector('[aria-label]');
    expect(region?.getAttribute('aria-label')).toMatch(ARABIC);
  });
});

describe('022 T054 (2+3) — labels stay associated, accessible names stay aligned', () => {
  it('each field is programmatically associated with its visible label', () => {
    render(<ManagerAdminSignInForm operator={makeBridge()} />);
    for (const testId of ['sign-in-identifier', 'sign-in-password']) {
      const input = screen.getByTestId(testId);
      const id = input.getAttribute('id');
      expect(id, `${testId} has no id to associate a label with`).toBeTruthy();
      const label = document.querySelector(`label[for="${id ?? ''}"]`);
      expect(label, `${testId} has no <label for=...>`).not.toBeNull();
      expect(label?.textContent).toMatch(ARABIC);
    }
  });

  it('no English aria-label is left shadowing an Arabic visible label (WCAG 2.5.3)', () => {
    render(<ManagerAdminSignInForm operator={makeBridge()} />);
    for (const testId of ['sign-in-identifier', 'sign-in-password']) {
      const input = screen.getByTestId(testId);
      // An aria-label here would OVERRIDE the visible <label>. If one is ever
      // added it must not be English, or the spoken name and the printed name
      // diverge — the exact mismatch this slice refused to create.
      const ariaLabel = input.getAttribute('aria-label');
      if (ariaLabel !== null) expect(ariaLabel).toMatch(ARABIC);
    }
  });
});

describe('022 T054 (4) — no English-only operator label remains on the sign-in journey', () => {
  it('the sign-in form renders no Latin-word operator label', () => {
    render(<ManagerAdminSignInForm operator={makeBridge()} onBack={vi.fn()} />);
    for (const label of Array.from(document.querySelectorAll('label'))) {
      expect(label.textContent, 'an English form label survived').not.toMatch(LATIN_WORD);
    }
    expect(screen.getByTestId('sign-in-submit').textContent).not.toMatch(LATIN_WORD);
    expect(screen.getByTestId('sign-in-back').textContent).not.toMatch(LATIN_WORD);
  });

  it('every aria-label on the sign-in surfaces is Arabic', () => {
    render(<ManagerAdminSignInForm operator={makeBridge()} />);
    render(<PinPad value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    for (const el of Array.from(document.querySelectorAll('[aria-label]'))) {
      const name = el.getAttribute('aria-label') ?? '';
      expect(name, `English accessible name survived: "${name}"`).not.toMatch(LATIN_WORD);
    }
  });
});

/** The visible text of the `<label for>` bound to a control. */
function labelTextFor(control: HTMLElement): string {
  const id = control.getAttribute('id') ?? '';
  return document.querySelector(`label[for="${id}"]`)?.textContent ?? '';
}
