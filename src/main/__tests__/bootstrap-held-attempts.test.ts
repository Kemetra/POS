import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-442 (RT-116 S5, §9) — composition-root guard: the #380 reversal sweep is
 * retired and nothing payment-related runs at boot (§6). The held-cart
 * lifecycle carries the payment side through `createHeldAttempts`.
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

describe('main/index.ts retires the session-end reversal sweep (RT-442)', () => {
  it('no longer wires a sweep or a session-end discard', () => {
    expect(source).not.toMatch(/sweepStuckAttempt|createStuckAttemptSweeper/);
    expect(source).not.toMatch(/DiscardOnSessionEnd/);
  });

  it('the modules are deleted', () => {
    expect(existsSync(resolve(__dirname, '../payments/sweep-stuck-attempt.ts'))).toBe(false);
    expect(
      existsSync(resolve(__dirname, '../payments/handlers/payments-discard-on-session-end.ts')),
    ).toBe(false);
  });

  it('the held-cart lifecycle gets the payment side', () => {
    const start = source.indexOf('createHeldCarts({');
    const end = source.indexOf('registerHeldCartLifecycle({', start);
    expect(start).toBeGreaterThan(0);
    expect(source.slice(start, end)).toContain('attempts: createHeldAttempts({');
  });
});
