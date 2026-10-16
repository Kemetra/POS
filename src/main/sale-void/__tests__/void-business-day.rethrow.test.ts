/**
 * RT-552 — `voidBusinessDay` marks only an unreadable instant (`BusinessDayError`)
 * as `invalid:`; any other fault from the day helper must surface, never be
 * masked as a silent `not_same_day` refusal.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/time/business-day.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/time/business-day.js')>();
  return {
    ...actual,
    businessDayOf: (iso: string): string => {
      if (iso === 'boom') throw new TypeError('formatter fault');
      return actual.businessDayOf(iso);
    },
  };
});

const { voidBusinessDay } = await import('../compose-sale-void.js');

describe('voidBusinessDay error handling', () => {
  it('marks an unreadable instant', () => {
    expect(voidBusinessDay('not-a-date')).toBe('invalid:not-a-date');
  });

  it('rethrows any other error instead of masking it', () => {
    expect(() => voidBusinessDay('boom')).toThrow(TypeError);
  });
});
