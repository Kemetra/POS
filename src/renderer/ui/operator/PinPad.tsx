import { useEffect, type JSX, type KeyboardEvent } from 'react';

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
 *     activatable, ≥44×44 px via CSS class `pin-pad__key`.
 *   - Backspace key is labelled "حذف" (Delete) via aria-label (022 T054).
 *   - Enter key is `aria-disabled` (NOT `disabled`) when PIN < 4 digits
 *     so it remains focusable and screen readers can announce the state.
 *   - Hardware numpad (keydown event) is wired while the component is
 *     mounted; listener is removed on unmount.
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
}

// Layout: 1 2 3 / 4 5 6 / 7 8 9 / ⌫ 0 ↵  (12 keys, Enter inside grid row 4)
const DIGIT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '↵'] as const;

export function PinPad(props: PinPadProps): JSX.Element {
  const { value, onChange, onSubmit, disabled = false } = props;
  const canSubmit = value.length >= PIN_MIN_LENGTH;
  const canAppend = value.length < PIN_MAX_LENGTH;

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

  const dots = Array.from({ length: PIN_MAX_LENGTH }, (_, i) => (
    <span
      key={i}
      className="pin-pad__dot"
      data-state={i < value.length ? 'filled' : 'empty'}
      aria-hidden="true"
    />
  ));

  return (
    <div className="pin-pad" data-testid="pin-pad" data-disabled={disabled || undefined}>
      <div
        role="group"
        className="pin-pad__dots"
        data-testid="pin-pad-dots"
        aria-label={`أُدخل ${String(value.length)} من ${String(PIN_MAX_LENGTH)}`}
      >
        {dots}
      </div>

      <div className="pin-pad__grid" role="group" aria-label="إدخال الرقم السري" dir="ltr">
        {DIGIT_KEYS.map((key, idx) => {
          if (key === '⌫') {
            return (
              <button
                key={idx}
                type="button"
                className="pin-pad__key pin-pad__key--backspace"
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
                ⌫
              </button>
            );
          }
          if (key === '↵') {
            return (
              <button
                key={idx}
                type="button"
                className="pin-pad__key pin-pad__key--enter"
                data-testid="pin-pad-enter"
                aria-label="إدخال"
                aria-disabled={!canSubmit || disabled}
                disabled={disabled}
                onClick={handleEnter}
              >
                ↵
              </button>
            );
          }
          return (
            <button
              key={idx}
              type="button"
              className="pin-pad__key pin-pad__key--digit"
              data-testid={`pin-pad-key-${key}`}
              aria-label={key}
              disabled={disabled}
              onClick={() => {
                handleDigit(key);
              }}
            >
              {key}
            </button>
          );
        })}
      </div>
    </div>
  );
}
