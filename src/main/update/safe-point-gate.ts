import type { SafePointBlocker, SafePointInputs, SafePointVerdict } from './update-types.js';

/**
 * RT-772 slice 2 / ADR-0006 P-4 — the ONE install predicate.
 *
 * An update may be installed only when no shift is open and nothing is in
 * flight (cart, payment, return, print). The same function answers at both
 * triggers (shift close and app start before sign-in); there is no second path.
 *
 * It fails closed: an input that cannot be read is a blocker (`unreadable`),
 * never a pass, and a failing input does not hide the others.
 */

export interface SafePointGate {
  isSafeToInstall(): SafePointVerdict;
}

const CHECKS: ReadonlyArray<readonly [keyof SafePointInputs, SafePointBlocker]> = [
  ['hasOpenShift', 'open_shift'],
  ['hasOpenCart', 'open_cart'],
  ['hasNonTerminalPayment', 'payment_in_flight'],
  ['hasReturnInFlight', 'return_in_flight'],
  ['isPrintInProgress', 'print_in_progress'],
];

function blockerFor(
  inputs: SafePointInputs,
  name: keyof SafePointInputs,
  blocker: SafePointBlocker,
): SafePointBlocker | null {
  try {
    return inputs[name]() ? blocker : null;
  } catch {
    return 'unreadable';
  }
}

export function createSafePointGate(inputs: SafePointInputs): SafePointGate {
  return {
    isSafeToInstall(): SafePointVerdict {
      const blockers = CHECKS.map(([name, blocker]) => blockerFor(inputs, name, blocker)).filter(
        (b): b is SafePointBlocker => b !== null,
      );
      return blockers.length === 0 ? { safe: true } : { safe: false, blockers };
    },
  };
}
