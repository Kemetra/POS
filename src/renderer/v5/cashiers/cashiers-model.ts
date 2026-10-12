import type { CashierPinState } from '../../../shared/bridge-api';
import { mapDigits } from '../../ui/forms/normalize-digits';

/**
 * RT-424 (RT-251 doc 19 §3–§4) — the pure rules of Manager → Cashiers.
 */

export type RowAction = 'first_pin' | 'change_pin' | 'unlock';

export interface RowActions {
  /** The state's own action, nearest the badge (G-3 slot one). */
  primary: 'first_pin' | 'unlock' | null;
  /** «تغيير الرقم السري» for a cashier who has a PIN (D1, G-3 slot two). */
  secondary: 'change_pin' | null;
}

/** The M2–M4 matrix. An action that does not fit the state is absent, never disabled (UX-05). */
export function rowActions(pin: CashierPinState): RowActions {
  switch (pin) {
    case 'no_pin':
      return { primary: 'first_pin', secondary: null };
    case 'ready':
      return { primary: null, secondary: 'change_pin' };
    case 'locked':
      return { primary: 'unlock', secondary: 'change_pin' };
  }
}

/** The cashier PIN rule (`pin-management.ts` PIN_RE). The 6–8 rule is the manager PIN's. */
const PIN_RE = /^\d{4,6}$/;

export type PinEntryCheck =
  | { kind: 'ok'; pin: string }
  | { kind: 'wrong_length' }
  | { kind: 'mismatch' };

/**
 * The renderer check before any call (doc 19 §4): both fields 4–6 digits, then
 * equal. Arabic-Indic and Persian digits count as digits (UX-08) and are sent
 * as Western digits. Main still validates; this only saves a round trip.
 */
export function checkPinEntry(first: string, second: string): PinEntryCheck {
  const a = mapDigits(first);
  const b = mapDigits(second);
  if (!PIN_RE.test(a) || !PIN_RE.test(b)) return { kind: 'wrong_length' };
  if (a !== b) return { kind: 'mismatch' };
  return { kind: 'ok', pin: a };
}

/** «حفظ» is enabled once both fields hold 4–6 digits (doc 19 §4); the match is checked on Save. */
export function canSavePin(first: string, second: string): boolean {
  return checkPinEntry(first, second).kind !== 'wrong_length';
}

const LOCK_TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** «حتى ‹HH:MM›» (D3): local wall-clock time, Western digits. Null when unparseable. */
export function formatLockTime(iso: string): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : LOCK_TIME.format(at);
}
