/**
 * RT-441 — recovery copy: one Arabic message per refusal, never an amount,
 * never another operator's identifier.
 */
import { describe, expect, it } from 'vitest';

import { APPROVAL_REFUSAL_REASONS } from '../../../../shared/operator/manager-approval';
import { RECOVERY_REFUSAL_REASONS } from '../../../../shared/operator/recovery';
import { RECOVERY_COPY, recoveryRefusalMessage } from '../recovery-copy';

const REASONS = [...new Set([...RECOVERY_REFUSAL_REASONS, ...APPROVAL_REFUSAL_REASONS])];

describe('recoveryRefusalMessage', () => {
  it.each(REASONS)('has its own Arabic message for %s, with no digits', (reason) => {
    const message = recoveryRefusalMessage(reason);
    expect(message).toMatch(/[؀-ۿ]/);
    expect(message).not.toMatch(/[0-9٠-٩]/);
  });

  it('approval_invalid does not claim expiry or a PIN fault (RT-837)', () => {
    const message = recoveryRefusalMessage('approval_invalid');
    expect(message).not.toMatch(/انتهى|انتهت|الرقم السري/);
  });

  it('falls back to the generic message for an unknown reason', () => {
    expect(recoveryRefusalMessage('something_new')).toBe(RECOVERY_COPY.unavailable);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RECOVERY_COPY)).toBe(true);
  });
});
