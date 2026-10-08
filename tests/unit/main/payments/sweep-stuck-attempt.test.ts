import { describe, expect, it, vi } from 'vitest';
import { createStuckAttemptSweeper } from '../../../../src/main/payments/sweep-stuck-attempt.js';
import type { PaymentAttemptRow } from '../../../../src/main/payments/repositories/payment-attempts.repository.js';

/**
 * #380 (F-007 part b) — orphan-attempt sweep.
 *
 * A stuck `started` payment attempt for the terminal bricks every future sale
 * (payments.start refuses `attempt_already_started_on_terminal`). This sweep —
 * fired on session-end (clean) and sign-in (crash recovery) — discards the
 * orphan via the existing `discardOnSessionEnd` machinery (LIFO-reverse + fail
 * + audit). It is keyed on the REAL terminal_id (resolved by the same accessor
 * the F-007 part-a flip uses), so an orphan on a DIFFERENT terminal is left
 * alone — the exact regression the F-007 fix prevents.
 */

function row(overrides: Partial<PaymentAttemptRow> = {}): PaymentAttemptRow {
  return {
    payment_attempt_id: 'pa-stuck',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'terminal-real',
    acting_operator_id: 'op-1',
    operator_session_id: 'sess-1',
    state: 'started',
    envelope_handoff_action_id: 'act-1',
    envelope_cart_id: 'cart-1',
    envelope_subtotal_minor: 2500,
    started_at: '2026-06-11T12:00:00.000Z',
    last_action_id: 'la-1',
    ...overrides,
  } as PaymentAttemptRow;
}

describe('#380 createStuckAttemptSweeper', () => {
  it('discards the stuck started attempt found for the resolved terminal', async () => {
    const stuck = row();
    const findStartedByTerminal = vi.fn((t: string) => (t === 'terminal-real' ? stuck : undefined));
    const discard = vi.fn(() => Promise.resolve({ kind: 'ok' as const, failed_at: 'x' }));
    const sweep = createStuckAttemptSweeper({
      attemptsRepo: { findStartedByTerminal },
      discard,
      resolveTerminalId: () => 'terminal-real',
      attemptHasLiveTender: () => false,
      logError: vi.fn(),
    });

    await sweep();

    expect(findStartedByTerminal).toHaveBeenCalledWith('terminal-real');
    expect(discard).toHaveBeenCalledWith({ payment_attempt_id: 'pa-stuck' });
  });

  it('leaves a stuck attempt on a DIFFERENT terminal alone (no discard)', async () => {
    // The orphan exists, but under a different terminal_id than this terminal's.
    const findStartedByTerminal = vi.fn((t: string) =>
      t === 'terminal-OTHER' ? row({ terminal_id: 'terminal-OTHER' }) : undefined,
    );
    const discard = vi.fn(() => Promise.resolve({ kind: 'ok' as const, failed_at: 'x' }));
    const sweep = createStuckAttemptSweeper({
      attemptsRepo: { findStartedByTerminal },
      discard,
      resolveTerminalId: () => 'terminal-real', // this terminal — has no orphan
      attemptHasLiveTender: () => false,
      logError: vi.fn(),
    });

    await sweep();

    expect(findStartedByTerminal).toHaveBeenCalledWith('terminal-real');
    expect(discard).not.toHaveBeenCalled();
  });

  it('is a no-op when the terminal is unpaired (resolver returns null)', async () => {
    const findStartedByTerminal = vi.fn(() => row());
    const discard = vi.fn(() => Promise.resolve({ kind: 'ok' as const, failed_at: 'x' }));
    const sweep = createStuckAttemptSweeper({
      attemptsRepo: { findStartedByTerminal },
      discard,
      resolveTerminalId: () => null,
      attemptHasLiveTender: () => false,
      logError: vi.fn(),
    });

    await sweep();

    expect(findStartedByTerminal).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it('logs (does not throw) when the discard handler rejects', async () => {
    const logError = vi.fn();
    const discard = vi.fn(() => Promise.reject(new Error('discard boom')));
    const sweep = createStuckAttemptSweeper({
      attemptsRepo: { findStartedByTerminal: () => row() },
      discard,
      resolveTerminalId: () => 'terminal-real',
      attemptHasLiveTender: () => false,
      logError,
    });

    await expect(sweep()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });

  // RT-117 (RT-116 §9 S1 interim) — an attempt holding LIVE tender
  // (applying | applied | reversal_pending) is never auto-reversed by a
  // session start/end. The money stays recorded; resolution is explicit.
  it('skips (never discards) a stuck attempt that holds live tender', async () => {
    const discard = vi.fn(() => Promise.resolve({ kind: 'ok' as const, failed_at: 'x' }));
    const attemptHasLiveTender = vi.fn((id: string) => id === 'pa-stuck');
    const sweep = createStuckAttemptSweeper({
      attemptsRepo: { findStartedByTerminal: () => row() },
      discard,
      resolveTerminalId: () => 'terminal-real',
      attemptHasLiveTender,
      logError: vi.fn(),
    });

    await sweep();

    expect(attemptHasLiveTender).toHaveBeenCalledWith('pa-stuck');
    expect(discard).not.toHaveBeenCalled();
  });

  it('still discards a zero-funds stuck attempt (no live tender)', async () => {
    const discard = vi.fn(() => Promise.resolve({ kind: 'ok' as const, failed_at: 'x' }));
    const sweep = createStuckAttemptSweeper({
      attemptsRepo: { findStartedByTerminal: () => row() },
      discard,
      resolveTerminalId: () => 'terminal-real',
      attemptHasLiveTender: () => false,
      logError: vi.fn(),
    });

    await sweep();

    expect(discard).toHaveBeenCalledWith({ payment_attempt_id: 'pa-stuck' });
  });

  it('skips the attempt (fail-closed) when the live-tender check throws', async () => {
    const discard = vi.fn(() => Promise.resolve({ kind: 'ok' as const, failed_at: 'x' }));
    const logError = vi.fn();
    const sweep = createStuckAttemptSweeper({
      attemptsRepo: { findStartedByTerminal: () => row() },
      discard,
      resolveTerminalId: () => 'terminal-real',
      attemptHasLiveTender: () => {
        throw new Error('db locked');
      },
      logError,
    });

    await expect(sweep()).resolves.toBeUndefined();
    expect(discard).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });
});
