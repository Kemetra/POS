import { describe, expect, it, vi } from 'vitest';

import { createSafePointGate } from '../safe-point-gate.js';
import type { SafePointInputs } from '../update-types.js';

/**
 * RT-772 slice 2 / ADR-0006 rule P-4 — the ONE install predicate. It is true only
 * when nothing is open or in flight, and it fails closed: an input that cannot be
 * read is a blocker, never a pass.
 */

const CLEAR: SafePointInputs = {
  hasOpenShift: () => false,
  hasOpenCart: () => false,
  hasNonTerminalPayment: () => false,
  hasReturnInFlight: () => false,
  isPrintInProgress: () => false,
};

describe('SafePointGate.isSafeToInstall', () => {
  it('is safe only when every input is clear', () => {
    expect(createSafePointGate(CLEAR).isSafeToInstall()).toEqual({ safe: true });
  });

  it.each([
    ['hasOpenShift', 'open_shift'],
    ['hasOpenCart', 'open_cart'],
    ['hasNonTerminalPayment', 'payment_in_flight'],
    ['hasReturnInFlight', 'return_in_flight'],
    ['isPrintInProgress', 'print_in_progress'],
  ] as const)('is unsafe when %s is true, naming %s', (input, blocker) => {
    const gate = createSafePointGate({ ...CLEAR, [input]: () => true });
    expect(gate.isSafeToInstall()).toEqual({ safe: false, blockers: [blocker] });
  });

  it('reports every blocker, in a stable order', () => {
    const gate = createSafePointGate({
      hasOpenShift: () => true,
      hasOpenCart: () => false,
      hasNonTerminalPayment: () => true,
      hasReturnInFlight: () => false,
      isPrintInProgress: () => true,
    });
    expect(gate.isSafeToInstall()).toEqual({
      safe: false,
      blockers: ['open_shift', 'payment_in_flight', 'print_in_progress'],
    });
  });

  it('fails closed when an input cannot be read', () => {
    const gate = createSafePointGate({
      ...CLEAR,
      hasOpenShift: () => {
        throw new Error('db is locked');
      },
    });
    expect(gate.isSafeToInstall()).toEqual({ safe: false, blockers: ['unreadable'] });
  });

  it('still evaluates the other inputs when one is unreadable', () => {
    const gate = createSafePointGate({
      ...CLEAR,
      hasOpenShift: () => {
        throw new Error('db is locked');
      },
      hasReturnInFlight: () => true,
    });
    expect(gate.isSafeToInstall()).toEqual({
      safe: false,
      blockers: ['unreadable', 'return_in_flight'],
    });
  });

  it('re-reads every input on each call (no cached verdict)', () => {
    const hasOpenShift = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const gate = createSafePointGate({ ...CLEAR, hasOpenShift });
    expect(gate.isSafeToInstall().safe).toBe(false);
    expect(gate.isSafeToInstall().safe).toBe(true);
    expect(hasOpenShift).toHaveBeenCalledTimes(2);
  });
});
