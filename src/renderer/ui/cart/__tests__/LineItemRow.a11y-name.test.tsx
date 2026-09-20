/**
 * 022 U2 / T063 — accessible name parity on the line note controls.
 *
 * U2 changed the add-note button's VISIBLE copy to Arabic (FR-19) while an
 * `aria-label="Add note"` was still in place. `aria-label` REPLACES descendant
 * text in the accessibility tree, so the control announced English while
 * displaying Arabic: voice-control users could not invoke it by the label they
 * saw, and AT read copy that was nowhere on screen (WCAG 2.5.3 Label in Name).
 *
 * The fix is to let the visible text name the button rather than to translate
 * the aria-label — an Arabic `aria-label` duplicating the visible Arabic text
 * would be redundant and could drift out of sync again.
 *
 * SCOPE: this guards the name THIS slice changed. The sibling note CHIP keeps
 * its `aria-label="Edit note"` deliberately — its visible content is user-typed
 * note text, so it genuinely needs an authored name, and accessible-name
 * language convergence across the renderer is U6's pass.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { LineItemRow } from '../LineItemRow.js';

afterEach(cleanup);

function renderRow(note: string | null): void {
  render(
    <LineItemRow
      lineId="line-1"
      displayName="باراسيتامول ٥٠٠ ملجم"
      quantity={1}
      unitPriceMinor={1250}
      lineSubtotalMinor={1250}
      note={note}
      hasNote={note !== null}
      onQuantityIncrement={vi.fn()}
      onQuantityDecrement={vi.fn()}
      onRemove={vi.fn()}
      onNoteOpen={vi.fn()}
    />,
  );
}

describe('U2 / T063 — note control accessible names', () => {
  it('names the add-note button by its visible Arabic text', () => {
    renderRow(null);

    const addNote = screen.getByTestId('line-note-add-btn');
    expect(addNote).not.toHaveAttribute('aria-label');
    expect(addNote).toHaveAccessibleName('إضافة ملاحظة');
  });

  it('keeps the note chip authored-named, since its content is user data', () => {
    renderRow('بعد الأكل');

    // Not a regression from the add-note fix: a chip whose visible text is the
    // user's own note needs a stable authored name. U6 owns its language.
    expect(screen.getByTestId('line-note-chip')).toHaveAttribute('aria-label', 'Edit note');
  });
});
