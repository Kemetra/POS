import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import {
  PinPad,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
} from '../../../../../src/renderer/ui/operator/PinPad.js';

/**
 * 004-operator-session T060 — PinPad unit extension (§A1).
 *
 * Novel coverage (does not duplicate PinPad.test.tsx or PinPad.dot-only-guard.test.tsx):
 *
 *   1. aria-disabled is "true" at exactly 0, 1, 2, 3 digits (each value below MIN_LENGTH).
 *   2. aria-disabled is "false" at exactly PIN_MIN_LENGTH digits.
 *   3. Enter click is a no-op at 1, 2, and 3 digits (verified via onSubmit mock).
 *   4. No digit value appears in any aria-* attribute anywhere in the rendered tree.
 *   5. Full rendered innerHTML does not contain the PIN string at partial fill.
 *   6. Console privacy: no console.log/warn/error emitted during digit entry or submit.
 */

function renderPinPad(value = '', onChange = vi.fn(), onSubmit = vi.fn(), disabled = false) {
  return render(
    <PinPad value={value} onChange={onChange} onSubmit={onSubmit} disabled={disabled} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ─── 1. aria-disabled per digit count ────────────────────────────────────────

describe('T060 — PinPad aria-disabled per digit count', () => {
  it.each([
    { title: '0 digits (empty)', pin: '' },
    { title: '1 digit', pin: '1' },
    { title: '2 digits', pin: '12' },
    {
      title: `${String(PIN_MIN_LENGTH - 1)} digits (one below minimum)`,
      pin: '1'.repeat(PIN_MIN_LENGTH - 1),
    },
  ])('is "true" at $title', ({ pin }) => {
    renderPinPad(pin);
    expect(screen.getByTestId('pin-pad-enter')).toHaveAttribute('aria-disabled', 'true');
  });

  it(`is "false" at exactly ${String(PIN_MIN_LENGTH)} digits (minimum)`, () => {
    renderPinPad('1'.repeat(PIN_MIN_LENGTH));
    expect(screen.getByTestId('pin-pad-enter')).toHaveAttribute('aria-disabled', 'false');
  });

  it(`is "false" at ${String(PIN_MAX_LENGTH)} digits (maximum)`, () => {
    renderPinPad('1'.repeat(PIN_MAX_LENGTH));
    expect(screen.getByTestId('pin-pad-enter')).toHaveAttribute('aria-disabled', 'false');
  });
});

// ─── 2. Enter is a no-op below minimum (per step) ────────────────────────────

describe('T060 — Enter click is no-op below MIN_LENGTH', () => {
  it('Enter click with 1 digit does not call onSubmit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('1', vi.fn(), onSubmit);
    await user.click(screen.getByTestId('pin-pad-enter'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter click with 2 digits does not call onSubmit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('12', vi.fn(), onSubmit);
    await user.click(screen.getByTestId('pin-pad-enter'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it(`Enter click with ${String(PIN_MIN_LENGTH - 1)} digits does not call onSubmit`, async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('1'.repeat(PIN_MIN_LENGTH - 1), vi.fn(), onSubmit);
    await user.click(screen.getByTestId('pin-pad-enter'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ─── 3. aria-* attribute privacy across the full rendered tree ───────────────

describe('T060 — aria-* attributes do not leak PIN value', () => {
  const PROBE_PIN = '7531';

  it('no aria-* attribute on any element contains the PIN string', () => {
    renderPinPad(PROBE_PIN);
    const container = screen.getByTestId('pin-pad');
    const allElements = container.querySelectorAll('*');
    for (const el of Array.from(allElements)) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('aria-')) {
          expect(attr.value).not.toContain(PROBE_PIN);
        }
      }
    }
  });

  it('no aria-label attribute on any element contains a raw digit sequence matching the PIN', () => {
    renderPinPad(PROBE_PIN);
    const container = screen.getByTestId('pin-pad');
    const allElements = container.querySelectorAll('[aria-label]');
    for (const el of Array.from(allElements)) {
      const label = el.getAttribute('aria-label') ?? '';
      // Digit keys have aria-label="0"…"9" — those are button labels, not the PIN.
      // The invariant: no aria-label should contain the full PIN string.
      expect(label).not.toContain(PROBE_PIN);
    }
  });
});

// ─── 4. innerHTML does not contain PIN value at partial fill ─────────────────

describe('T060 — innerHTML does not expose PIN at partial fill', () => {
  it('pin-pad innerHTML does not contain partial PIN "123"', () => {
    renderPinPad('123');
    const container = screen.getByTestId('pin-pad');
    expect(container.innerHTML).not.toContain('123');
  });

  it('pin-pad innerHTML does not contain partial PIN "9876"', () => {
    renderPinPad('9876');
    const container = screen.getByTestId('pin-pad');
    expect(container.innerHTML).not.toContain('9876');
  });
});

// ─── 5. Console privacy during digit entry and submit ─────────────────────────

describe('T060 — console privacy: no PIN leakage via console during interaction', () => {
  it('entering digits produces no console.log output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('', onChange);
    for (const d of ['1', '2', '3', '4']) {
      await user.click(screen.getByTestId(`pin-pad-key-${d}`));
    }
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('entering digits produces no console.warn output', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderPinPad('');
    for (const d of ['1', '2', '3', '4']) {
      await user.click(screen.getByTestId(`pin-pad-key-${d}`));
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('clicking Enter at PIN_MIN_LENGTH produces no console.error output', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('1'.repeat(PIN_MIN_LENGTH), vi.fn(), onSubmit);
    await user.click(screen.getByTestId('pin-pad-enter'));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
