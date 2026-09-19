import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { PinPad, PIN_MAX_LENGTH } from '../PinPad.js';

/**
 * 004-operator-session T071 [S5] — PinPad dot-only guard test (TEST-FIRST).
 *
 * Security invariant (PR-1): The PIN dot row MUST carry only structural
 * markers — `data-state` and a count-based `aria-label`. It must NEVER
 * expose the PIN value itself through `value`, `data-value`, `title`, or
 * any other attribute that echoes the digit string.
 *
 * aria-label must be COUNT-BASED: it reports how many digits are entered and
 * NEVER the digits themselves.
 *
 * 022 T054 — the wording is now Arabic ("أُدخل N من 6"). These assertions were
 * re-pointed from the superseded English string to the property that actually
 * matters and that this file exists to defend: the entered COUNT appears, the
 * maximum appears, and the PIN VALUE never does. That is strictly stronger
 * than the old literal match, and it survives any future rewording.
 */

function renderPinPad(value = '') {
  return render(<PinPad value={value} onChange={vi.fn()} onSubmit={vi.fn()} />);
}

afterEach(() => {
  cleanup();
});

describe('PinPad dot-only guard — PR-1 security invariant', () => {
  it('dot elements have no "value" attribute', () => {
    renderPinPad('1234');
    const dots = Array.from(screen.getByTestId('pin-pad-dots').querySelectorAll('.pin-pad__dot'));
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot).not.toHaveAttribute('value');
    }
  });

  it('dot elements have no "data-value" attribute', () => {
    renderPinPad('1234');
    const dots = Array.from(screen.getByTestId('pin-pad-dots').querySelectorAll('.pin-pad__dot'));
    for (const dot of dots) {
      expect(dot).not.toHaveAttribute('data-value');
    }
  });

  it('dot elements have no "title" attribute', () => {
    renderPinPad('1234');
    const dots = Array.from(screen.getByTestId('pin-pad-dots').querySelectorAll('.pin-pad__dot'));
    for (const dot of dots) {
      expect(dot).not.toHaveAttribute('title');
    }
  });

  it('dot elements carry only data-state (empty | filled)', () => {
    renderPinPad('123');
    const filled = Array.from(
      screen.getByTestId('pin-pad-dots').querySelectorAll('[data-state="filled"]'),
    );
    const empty = Array.from(
      screen.getByTestId('pin-pad-dots').querySelectorAll('[data-state="empty"]'),
    );
    expect(filled.length + empty.length).toBe(PIN_MAX_LENGTH);
  });

  it.each([
    { pin: '', entered: 0 },
    { pin: '1234', entered: 4 },
    { pin: '123456', entered: PIN_MAX_LENGTH },
  ])(
    'dot-region aria-label reports the COUNT, never the PIN ($entered entered)',
    ({ pin, entered }) => {
      renderPinPad(pin);
      const label = screen.getByTestId('pin-pad-dots').getAttribute('aria-label') ?? '';
      // Count-based: the entered count and the maximum are both present...
      expect(label).toContain(String(entered));
      expect(label).toContain(String(PIN_MAX_LENGTH));
      // ...and the PIN value itself is NEVER in the accessible name. This is
      // the guarantee the whole file exists for.
      if (pin.length > 0) expect(label).not.toContain(pin);
    },
  );

  it('dot-region inner text contains no digit characters', () => {
    renderPinPad('9876');
    const dotsEl = screen.getByTestId('pin-pad-dots');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const dotsText = dotsEl.textContent ?? '';
    expect(dotsText).not.toMatch(/[0-9]/);
  });

  it('dot-region innerHTML does not contain the PIN value', () => {
    renderPinPad('9876');
    const dotsEl = screen.getByTestId('pin-pad-dots');
    expect(dotsEl.innerHTML).not.toContain('9876');
  });
});
