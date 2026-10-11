import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { PinPad, PinPadPreview, PIN_MAX_LENGTH } from '../PinPad.js';

/**
 * 004-operator-session T074 — PinPad component tests.
 *
 * Verifies:
 *   - Renders 3×4 grid + dot indicators + Enter button.
 *   - Digit buttons append to the PIN (via onChange).
 *   - Backspace button removes the last digit.
 *   - Enter fires onSubmit only when PIN >= PIN_MIN_LENGTH.
 *   - Enter is aria-disabled below minimum length.
 *   - PIN digits NEVER appear as text in the DOM (PR-1).
 *   - Dot data-state markers reflect fill state.
 *   - Hardware numpad (keydown) parity: 0–9, Backspace, Enter.
 *   - Disabled state: all keys are no-ops.
 *   - PIN truncated at PIN_MAX_LENGTH.
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

describe('PinPad — rendering', () => {
  it('renders the pin-pad container', () => {
    renderPinPad();
    expect(screen.getByTestId('pin-pad')).toBeInTheDocument();
  });

  it('renders digit buttons 0–9', () => {
    renderPinPad();
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(screen.getByTestId(`pin-pad-key-${d}`)).toBeInTheDocument();
    }
  });

  it('renders backspace and enter buttons', () => {
    renderPinPad();
    expect(screen.getByTestId('pin-pad-backspace')).toBeInTheDocument();
    expect(screen.getByTestId('pin-pad-enter')).toBeInTheDocument();
  });

  it('renders PIN_MAX_LENGTH dot indicators', () => {
    renderPinPad();
    const dots = Array.from(screen.getByTestId('pin-pad-dots').querySelectorAll('.v5-entry__dot'));
    expect(dots).toHaveLength(PIN_MAX_LENGTH);
  });

  it('PR #434 FIX 3: keypad grid is LTR-isolated (dir="ltr") under an RTL shell', () => {
    // The app shell root is dir="rtl"; the 1-2-3 / 4-5-6 / 7-8-9 / ·-0-⌫ keypad
    // must auto-place left-to-right regardless of inherited direction, else the
    // grid mirrors. dir is a standard HTML attribute, not a new component prop.
    const { container } = renderPinPad();
    const grid = container.querySelector('.v5-entry__keypad');
    expect(grid).not.toBeNull();
    expect(grid).toHaveAttribute('dir', 'ltr');
  });

  it('PR-1: PIN value is never rendered as plaintext in the dot region', () => {
    // The dot region must show ONLY data-state markers — no digit text.
    // Digit buttons render their label (0–9) as accessible text — that's
    // correct. The invariant is that the actual PIN value '9876' does NOT
    // appear in the dots section, only filled/empty state attributes.
    renderPinPad('9876');
    const dotsEl = screen.getByTestId('pin-pad-dots');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const dotsText = dotsEl.textContent ?? '';
    // The dots region should contain no digit text at all.
    expect(dotsText).not.toMatch(/[0-9]/);
    // And the PIN value itself must not be in any data attribute as plaintext.
    expect(dotsEl.innerHTML).not.toContain('9876');
  });
});

describe('PinPad — dot state', () => {
  it('all dots are empty when value is empty string', () => {
    renderPinPad('');
    const dots = Array.from(screen.getByTestId('pin-pad-dots').querySelectorAll('[data-state]'));
    for (const dot of dots) {
      expect(dot).toHaveAttribute('data-state', 'empty');
    }
  });

  it('filled dots equal value.length', () => {
    renderPinPad('123');
    const filled = Array.from(
      screen.getByTestId('pin-pad-dots').querySelectorAll('[data-state="filled"]'),
    );
    expect(filled).toHaveLength(3);
  });

  it('empty dots equal PIN_MAX_LENGTH - value.length', () => {
    renderPinPad('12');
    const empty = Array.from(
      screen.getByTestId('pin-pad-dots').querySelectorAll('[data-state="empty"]'),
    );
    expect(empty).toHaveLength(PIN_MAX_LENGTH - 2);
  });
});

describe('PinPad — digit buttons', () => {
  it('clicking a digit calls onChange with appended digit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('12', onChange);
    await user.click(screen.getByTestId('pin-pad-key-3'));
    expect(onChange).toHaveBeenCalledWith('123');
  });

  it('clicking all digits builds the PIN string', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const onChange = vi.fn((v: string) => calls.push(v));
    renderPinPad('', onChange);
    for (const d of ['1', '2', '3', '4']) {
      // Re-render with the updated value between clicks would require
      // a controlled wrapper — instead verify each onChange call.
      await user.click(screen.getByTestId(`pin-pad-key-${d}`));
    }
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(calls[0]).toBe('1');
  });

  it('does not call onChange when value is already at max length', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('1'.repeat(PIN_MAX_LENGTH), onChange);
    await user.click(screen.getByTestId('pin-pad-key-5'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PinPad — backspace', () => {
  it('clicking backspace calls onChange with last digit removed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('1234', onChange);
    await user.click(screen.getByTestId('pin-pad-backspace'));
    expect(onChange).toHaveBeenCalledWith('123');
  });

  it('clicking backspace on empty string does not call onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('', onChange);
    await user.click(screen.getByTestId('pin-pad-backspace'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PinPad — enter button', () => {
  it('Enter button is aria-disabled when PIN < MIN_LENGTH', () => {
    renderPinPad('12');
    const enterBtn = screen.getByTestId('pin-pad-enter');
    expect(enterBtn).toHaveAttribute('aria-disabled', 'true');
  });

  it('Enter button is NOT aria-disabled when PIN >= MIN_LENGTH', () => {
    renderPinPad('1234');
    const enterBtn = screen.getByTestId('pin-pad-enter');
    expect(enterBtn).toHaveAttribute('aria-disabled', 'false');
  });

  it('clicking Enter when PIN >= MIN_LENGTH calls onSubmit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('1234', vi.fn(), onSubmit);
    await user.click(screen.getByTestId('pin-pad-enter'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('clicking Enter when PIN < MIN_LENGTH does NOT call onSubmit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('12', vi.fn(), onSubmit);
    await user.click(screen.getByTestId('pin-pad-enter'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('PinPad — disabled state', () => {
  it('digit buttons do not call onChange when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('', onChange, vi.fn(), true);
    await user.click(screen.getByTestId('pin-pad-key-5'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('backspace does not call onChange when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('1234', onChange, vi.fn(), true);
    await user.click(screen.getByTestId('pin-pad-backspace'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('enter does not call onSubmit when disabled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('1234', vi.fn(), onSubmit, true);
    // Enter button itself is disabled; click is ignored.
    const enterBtn = screen.getByTestId('pin-pad-enter');
    await user.click(enterBtn);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('PinPad — hardware numpad (keydown)', () => {
  it('keydown digit appends to PIN via onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('12', onChange);
    // Focus the component so keydown fires in its listener.
    screen.getByTestId('pin-pad').focus();
    await user.keyboard('5');
    expect(onChange).toHaveBeenCalledWith('125');
  });

  it('keydown Backspace removes last digit via onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPinPad('123', onChange);
    screen.getByTestId('pin-pad').focus();
    await user.keyboard('{Backspace}');
    expect(onChange).toHaveBeenCalledWith('12');
  });

  it('keydown Enter fires onSubmit when PIN >= MIN_LENGTH', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('1234', vi.fn(), onSubmit);
    screen.getByTestId('pin-pad').focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keydown Enter is a no-op when PIN < MIN_LENGTH', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderPinPad('12', vi.fn(), onSubmit);
    screen.getByTestId('pin-pad').focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('PinPad — backspace onKeyDown handler', () => {
  it('pressing Enter on the backspace button triggers handleBackspace', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const onChange = vi.fn();
    renderPinPad('1234', onChange);
    const backspaceBtn = screen.getByTestId('pin-pad-backspace');
    fireEvent.keyDown(backspaceBtn, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('123');
  });

  it('pressing Space on the backspace button triggers handleBackspace', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const onChange = vi.fn();
    renderPinPad('1234', onChange);
    const backspaceBtn = screen.getByTestId('pin-pad-backspace');
    fireEvent.keyDown(backspaceBtn, { key: ' ' });
    expect(onChange).toHaveBeenCalledWith('123');
  });

  it('pressing other keys on the backspace button is a no-op', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const onChange = vi.fn();
    renderPinPad('1234', onChange);
    const backspaceBtn = screen.getByTestId('pin-pad-backspace');
    fireEvent.keyDown(backspaceBtn, { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PinPad — RT-244 G-1 layout', () => {
  it('lays the bottom row out as blank · 0 · ⌫, with no ↵ key in the grid', () => {
    const { container } = renderPinPad();
    const grid = container.querySelector('.v5-entry__keypad');
    const cells = Array.from(grid?.children ?? []);
    expect(cells).toHaveLength(12);
    expect(cells[9]).toHaveAttribute('aria-hidden', 'true');
    expect(cells[10]).toBe(screen.getByTestId('pin-pad-key-0'));
    expect(cells[11]).toBe(screen.getByTestId('pin-pad-backspace'));
    expect(grid?.textContent).not.toContain('↵');
  });

  it('the commit sits under the keypad and carries the given Arabic label', () => {
    render(<PinPad value="" onChange={vi.fn()} onSubmit={vi.fn()} submitLabel="دخول" />);
    const commit = screen.getByTestId('pin-pad-enter');
    expect(commit).toHaveTextContent('دخول');
    const grid = screen.getByRole('group', { name: 'إدخال الرقم السري' });
    expect(grid.compareDocumentPosition(commit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the feedback slot between the dots and the keypad', () => {
    render(
      <PinPad
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        feedback={<span data-testid="slot-content">x</span>}
      />,
    );
    const dots = screen.getByTestId('pin-pad-dots');
    const slot = screen.getByTestId('slot-content');
    const grid = screen.getByRole('group', { name: 'إدخال الرقم السري' });
    expect(dots.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('marks the dots field refused and links it to the message', () => {
    render(<PinPad value="" onChange={vi.fn()} onSubmit={vi.fn()} error describedBy="err-id" />);
    const dots = screen.getByTestId('pin-pad-dots');
    expect(dots).toHaveAttribute('data-error', 'true');
    expect(dots).toHaveAttribute('aria-describedby', 'err-id');
  });
});

describe('PinPadPreview — the PIN column before a cashier is picked', () => {
  it('shows the prompt and a fully disabled keypad and commit', () => {
    render(<PinPadPreview prompt="اختر اسمك" />);
    expect(screen.getByTestId('pin-awaiting-selection')).toHaveTextContent('اختر اسمك');
    const keys = screen.getByTestId('pin-pad-preview').querySelectorAll('button');
    expect(keys.length).toBe(12);
    for (const key of Array.from(keys)) expect(key).toBeDisabled();
  });

  it('accepts no input: no keyboard listener, no PIN dots', async () => {
    render(<PinPadPreview prompt="اختر اسمك" />);
    const user = userEvent.setup();
    await user.keyboard('1234{Enter}');
    expect(screen.queryByTestId('pin-pad-dots')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pin-pad')).not.toBeInTheDocument();
  });
});
