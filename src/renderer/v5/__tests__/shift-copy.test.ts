/**
 * RT-17 slice 4 part 3 — every typed shift refusal maps to its own Arabic
 * message (a closed set): no internal reason token, no identifier, no amount.
 */
import { describe, expect, it } from 'vitest';

import { SHIFT_CASHUP_REFUSALS } from '../../../shared/shift-cashup/types';
import { SHIFT_COPY, shiftRefusalMessage } from '../shift/shift-copy';

describe('shiftRefusalMessage — the closed refusal set', () => {
  it.each(SHIFT_CASHUP_REFUSALS)('maps %s to its own Arabic message', (reason) => {
    const message = shiftRefusalMessage(reason);
    expect(message).toMatch(/[؀-ۿ]/);
    expect(message).not.toBe(SHIFT_COPY.unknownRefusal);
    expect(message).not.toContain(reason);
    // No internal token, identifier or Latin text leaks into the copy.
    expect(message).not.toMatch(/[A-Za-z_]/);
  });

  it('gives every refusal a distinct message', () => {
    const messages = SHIFT_CASHUP_REFUSALS.map((reason) => shiftRefusalMessage(reason));
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('keeps the pay-out refusal generic: no amount, bound or digit', () => {
    expect(shiftRefusalMessage('pay_out_not_accepted')).not.toMatch(/[0-9٠-٩]/);
  });

  it.each(['pay_out_exceeds_drawer_cash', 'approver_expired', 'aggregate_out_of_range', ''])(
    'answers a reason outside the closed set (%j) with the generic line',
    (reason) => {
      expect(shiftRefusalMessage(reason as never)).toBe(SHIFT_COPY.unknownRefusal);
    },
  );

  it('does not answer an inherited key as a reason', () => {
    expect(shiftRefusalMessage('toString' as never)).toBe(SHIFT_COPY.unknownRefusal);
  });

  it('tells a manager whose step-up expired to sign in again', () => {
    expect(shiftRefusalMessage('reauth_required')).toContain('سجّل');
  });
});
