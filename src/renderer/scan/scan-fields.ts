import type { RefuseKind } from './scan-messages.js';

/**
 * RT-239 (VNext A2) — how the scan guard recognises and restores form fields.
 *
 * Money, PIN and card-reference fields are recognised by what they ARE, so a new
 * field is refused by default rather than by someone remembering to opt in:
 * `type="password"` is a PIN/secret, a numeric or decimal input mode is an
 * amount. A field the inference cannot see (the card reference is plain text)
 * declares itself with `data-scan-refuse`, which always wins.
 */

export const SCAN_REFUSE_ATTR = 'data-scan-refuse';
export const SCAN_TARGET_ATTR = 'data-scan-target';

export type ScanField = HTMLInputElement | HTMLTextAreaElement;

/** Input types a person types text into. Radios, checkboxes and buttons are not fields. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'password',
  'tel',
  'number',
  'email',
  'url',
]);

function isRefuseKind(value: string | null): value is RefuseKind {
  return value === 'amount' || value === 'pin' || value === 'reference';
}

/** The element as a text field, or null for buttons, rows, the body and non-text inputs. */
export function asTextField(el: Element | null): ScanField | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) return el;
  return null;
}

/** Which kind of protected field this is, or null when scans may be routed away from it. */
export function refuseKindOf(field: ScanField): RefuseKind | null {
  const declared = field.getAttribute(SCAN_REFUSE_ATTR);
  if (isRefuseKind(declared)) return declared;
  if (field instanceof HTMLInputElement && field.type === 'password') return 'pin';
  const mode = field.inputMode;
  return mode === 'decimal' || mode === 'numeric' ? 'amount' : null;
}

export type ScanTarget = 'search' | 'note';

/**
 * A text field that opts in to being a scan's landing place. `search` owns
 * typing but a burst typed into it is a scan (the field is then cleared);
 * `note` is free text a scan must not pollute (the field is put back). Any
 * other text field is not the guard's business and is left exactly as it was.
 */
export function scanTargetOf(field: ScanField): ScanTarget | null {
  const declared = field.getAttribute(SCAN_TARGET_ATTR);
  return declared === 'search' || declared === 'note' ? declared : null;
}

/**
 * Set a controlled field's value so React state follows. A plain `value =`
 * assignment would be overwritten by the next render.
 */
export function setFieldValue(field: ScanField, value: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
