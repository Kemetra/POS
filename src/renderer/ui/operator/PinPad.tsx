import { useEffect, useMemo, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';

import { useRefuseSurface } from '../../scan/ScanGuardHost';
import type { RefuseSurface } from '../../scan/scan-guard';
import { Icon } from '../../icons/Icon';

/**
 * 004-operator-session T074 — PinPad component (Surface 4).
 *
 * Controlled component: the parent owns the PIN string. This component
 * is purely presentational — it renders the 3×4 keypad and dot
 * indicators but never stores PIN material in local state.
 *
 * Security (PR-1):
 *   - PIN digits NEVER appear as text in the DOM. The dot region uses
 *     filled/empty data-state markers only.
 *   - `aria-live="off"` on the dot region — screen-reader announcement
 *     of digit count would leak timing information.
 *   - The `value` prop is consumed for dot-count only; the component
 *     never renders it as a string.
 *
 * Accessibility:
 *   - Each digit key is a `<button type="button">` — pointer + keyboard
 *     activatable, ≥44×44 px.
 *   - Backspace key is labelled "حذف" (Delete) via aria-label (022 T054).
 *   - The «دخول» commit is `aria-disabled` (NOT `disabled`) when PIN < 4
 *     digits so it remains focusable and screen readers can announce the state.
 *   - Hardware numpad (keydown event) is wired while the component is
 *     mounted; listener is removed on unmount.
 *
 * RT-244 (VNext W1-D, G-1 references): the keypad is LTR with 1-2-3 on top and
 * a bottom row of blank · 0 · ⌫. The former ↵ key is now the full-width «دخول»
 * commit under the keypad (same `pin-pad-enter` test id); a physical Enter
 * still submits. `feedback` is the reserved slot between the dots and the
 * keypad, so a refusal never moves the keypad.
 */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

export interface PinPadProps {
  /** Current PIN value (parent-controlled). Max PIN_MAX_LENGTH digits. */
  value: string;
  /** Called with the new PIN value on every key press. */
  onChange: (pin: string) => void;
  /** Called when Enter is pressed and PIN meets minimum length. */
  onSubmit: () => void;
  /** Disables all keys (e.g. while sign-in request is in flight). */
  disabled?: boolean;
  /** Marks the dots field as refused (danger boundary). */
  error?: boolean;
  /** The reserved slot between the dots and the keypad (status or refusal). */
  feedback?: ReactNode;
  /** The commit's visible label. */
  submitLabel?: string;
  /** Wires the dots region to the refusal message, when one is shown. */
  describedBy?: string;
  /** Moves focus to the PIN field on mount (a cashier was just picked). */
  autoFocus?: boolean;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function PinPad(props: Readonly<PinPadProps>): JSX.Element {
  const {
    value,
    onChange,
    onSubmit,
    disabled = false,
    error = false,
    feedback,
    submitLabel = 'دخول',
    describedBy,
    autoFocus = false,
  } = props;
  const canSubmit = value.length >= PIN_MIN_LENGTH;
  const canAppend = value.length < PIN_MAX_LENGTH;

  // RT-239: the pad takes digits from `window`, with no input element, so the
  // scan guard cannot restore it by itself. A scan must never become a PIN:
  // the guard puts back the value the pad had when the burst began.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const scanSurface = useMemo<RefuseSurface>(
    () => ({
      snapshot: () => valueRef.current,
      restore: (previous) => {
        onChangeRef.current(previous);
      },
    }),
    [],
  );
  useRefuseSurface('pin', scanSurface);

  const handleDigit = (digit: string): void => {
    if (disabled || !canAppend) return;
    onChange(value + digit);
  };

  const handleBackspace = (): void => {
    if (disabled) return;
    if (value.length > 0) onChange(value.slice(0, -1));
  };

  const handleEnter = (): void => {
    if (disabled || !canSubmit) return;
    onSubmit();
  };

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (disabled) return;
      if (e.key >= '0' && e.key <= '9') {
        if (canAppend) onChange(value + e.key);
        e.preventDefault();
      } else if (e.key === 'Backspace') {
        if (value.length > 0) onChange(value.slice(0, -1));
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (canSubmit) onSubmit();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [value, disabled, canAppend, canSubmit, onChange, onSubmit]);

  return (
    <div className="v5-entry__pin" data-testid="pin-pad" data-disabled={disabled || undefined}>
      <PinDots
        filled={value.length}
        error={error}
        describedBy={describedBy}
        autoFocus={autoFocus}
      />
      <div className="v5-entry__feedback">{feedback}</div>

      <div className="v5-entry__keypad" role="group" aria-label="إدخال الرقم السري" dir="ltr">
        {DIGITS.map((key) => (
          <DigitKey key={key} digit={key} disabled={disabled} onPress={handleDigit} />
        ))}
        <span className="v5-entry__key v5-entry__key--blank" aria-hidden="true" />
        <DigitKey digit="0" disabled={disabled} onPress={handleDigit} />
        <button
          type="button"
          className="v5-entry__key"
          data-testid="pin-pad-backspace"
          aria-label="حذف"
          disabled={disabled}
          onClick={handleBackspace}
          onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleBackspace();
            }
          }}
        >
          <Icon name="backspace" size="lg" />
        </button>
      </div>

      <div className="v5-entry__auth-actions">
        <button
          type="button"
          className="v5-entry__btn v5-entry__btn--primary v5-entry__commit"
          data-testid="pin-pad-enter"
          aria-disabled={!canSubmit || disabled}
          disabled={disabled}
          onClick={handleEnter}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function DigitKey({
  digit,
  disabled,
  onPress,
}: Readonly<{
  digit: string;
  disabled: boolean;
  onPress: (digit: string) => void;
}>): JSX.Element {
  return (
    <button
      type="button"
      className="v5-entry__key"
      data-testid={`pin-pad-key-${digit}`}
      aria-label={digit}
      disabled={disabled}
      onClick={() => {
        onPress(digit);
      }}
    >
      {digit}
    </button>
  );
}

/**
 * The PIN field: a focusable textbox (G-1 state 3), so assistive technology
 * announces the active credential field, its label and the refusal it is
 * described by. Digits arrive through the pad's window listener; the field
 * never holds them, and its only content is the masked dots.
 */
function PinDots({
  filled,
  error,
  describedBy,
  autoFocus,
}: Readonly<{
  filled: number;
  error: boolean;
  describedBy?: string | undefined;
  autoFocus: boolean;
}>): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div
      ref={ref}
      role="textbox"
      tabIndex={0}
      className="v5-entry__dots"
      data-testid="pin-pad-dots"
      data-error={error || undefined}
      aria-invalid={error || undefined}
      aria-label={`الرقم السري، أُدخل ${String(filled)} من ${String(PIN_MAX_LENGTH)}`}
      aria-describedby={describedBy}
    >
      {Array.from({ length: PIN_MAX_LENGTH }, (_, i) => (
        <span
          key={i}
          className="v5-entry__dot"
          data-state={i < filled ? 'filled' : 'empty'}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/**
 * RT-244 — the PIN column before a cashier is picked: the same keypad, shown
 * disabled with a prompt in place of the dots, so picking a name never reflows
 * the layout. It wires no keyboard listener and no scan surface: nothing here
 * accepts input.
 */
export function PinPadPreview({
  prompt,
  submitLabel = 'دخول',
}: Readonly<{
  prompt: string;
  submitLabel?: string;
}>): JSX.Element {
  return (
    <div className="v5-entry__pin" data-testid="pin-pad-preview">
      <p className="v5-entry__prompt" data-testid="pin-awaiting-selection">
        {prompt}
      </p>
      <div className="v5-entry__feedback" />
      <div
        className="v5-entry__keypad"
        role="group"
        aria-label="إدخال الرقم السري"
        aria-disabled="true"
        dir="ltr"
      >
        {DIGITS.map((key) => (
          <button key={key} type="button" className="v5-entry__key" disabled>
            {key}
          </button>
        ))}
        <span className="v5-entry__key v5-entry__key--blank" aria-hidden="true" />
        <button type="button" className="v5-entry__key" disabled>
          0
        </button>
        <button type="button" className="v5-entry__key" aria-label="حذف" disabled>
          <Icon name="backspace" size="lg" />
        </button>
      </div>
      <div className="v5-entry__auth-actions">
        <button
          type="button"
          className="v5-entry__btn v5-entry__btn--primary v5-entry__commit"
          disabled
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
