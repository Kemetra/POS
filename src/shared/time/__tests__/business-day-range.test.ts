/**
 * RT-541 — store business-day ranges, derived from the RT-550 rule. A range of
 * Cairo business days maps to a half-open `[startInclusive, endExclusive)`
 * window of instants. The bounds must agree with `businessDayOf` on every day,
 * including the 23-hour spring-forward day and the 25-hour fall-back day, so
 * no fixed `+02:00`/`+03:00` offset can be used.
 */
import { describe, expect, it } from 'vitest';

import {
  BusinessDayError,
  businessDayBounds,
  businessDayOf,
  businessDaySpan,
  isBusinessDay,
} from '../business-day.js';

const MS = 1;

describe('isBusinessDay', () => {
  it.each(['2026-10-16', '2028-02-29', '1999-01-01'])('accepts %s', (day) => {
    expect(isBusinessDay(day)).toBe(true);
  });

  it.each([
    ['not a string', 20261016],
    ['undefined', undefined],
    ['a date-time', '2026-10-16T00:00:00Z'],
    ['no padding', '2026-1-6'],
    ['not a real date', '2026-02-30'],
    ['not a leap year', '2026-02-29'],
    ['month 13', '2026-13-01'],
    ['trailing text', '2026-10-16x'],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(isBusinessDay(value)).toBe(false);
  });
});

describe('businessDaySpan', () => {
  it.each([
    ['one day', '2026-10-16', '2026-10-16', 1],
    ['two days', '2026-10-15', '2026-10-16', 2],
    ['31 days', '2026-10-01', '2026-10-31', 31],
    ['across a month end', '2026-01-31', '2026-02-01', 2],
    ['across the fall-back day', '2026-10-28', '2026-10-30', 3],
    ['across a leap day', '2028-02-28', '2028-03-01', 3],
  ])('%s', (_label, from, to, expected) => {
    expect(businessDaySpan({ from, to })).toBe(expected);
  });

  it('is zero or negative when to is before from', () => {
    expect(businessDaySpan({ from: '2026-10-16', to: '2026-10-15' })).toBe(0);
  });

  it('refuses a malformed day', () => {
    expect(() => businessDaySpan({ from: '2026-02-30', to: '2026-03-01' })).toThrow(
      BusinessDayError,
    );
  });
});

describe('businessDayBounds', () => {
  /** `<day>T<hour>` → the full `Date#toISOString` instant at that UTC hour. */
  const at = (dayHour: string): string => `${dayHour}:00:00.000Z`;

  it.each([
    // [label, day, UTC hour it starts, UTC hour the next day starts]
    ['winter day (UTC+2)', '2026-01-15', '2026-01-14T22', '2026-01-15T22'],
    ['summer day (UTC+3)', '2026-07-15', '2026-07-14T21', '2026-07-15T21'],
    ['N-10 day', '2026-10-07', '2026-10-06T21', '2026-10-07T21'],
    // 25 hours: local 23:00-24:00 repeats at the end of summer time.
    ['fall-back day', '2026-10-29', '2026-10-28T21', '2026-10-29T22'],
    // 23 hours: local 00:00-01:00 is skipped at the start of summer time.
    ['spring-forward day', '2026-04-24', '2026-04-23T22', '2026-04-24T21'],
    ['year end', '2026-12-31', '2026-12-30T22', '2026-12-31T22'],
  ])('%s', (_label, day, start, end) => {
    expect(businessDayBounds({ from: day, to: day })).toEqual({
      startInclusive: at(start),
      endExclusive: at(end),
    });
  });

  it('spans a multi-day range from the first start to the last end', () => {
    expect(businessDayBounds({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      startInclusive: at('2026-09-30T21'),
      endExclusive: at('2026-10-31T22'),
    });
  });

  it.each([
    '2026-01-15',
    '2026-04-23',
    '2026-04-24',
    '2026-04-25',
    '2026-07-15',
    '2026-10-28',
    '2026-10-29',
    '2026-10-30',
    '2028-02-29',
  ])('agrees with businessDayOf on both sides of each edge of %s', (day) => {
    const { startInclusive, endExclusive } = businessDayBounds({ from: day, to: day });
    const start = Date.parse(startInclusive);
    const end = Date.parse(endExclusive);
    expect(businessDayOf(new Date(start))).toBe(day);
    expect(businessDayOf(new Date(start - MS))).not.toBe(day);
    expect(businessDayOf(new Date(end - MS))).toBe(day);
    expect(businessDayOf(new Date(end))).not.toBe(day);
  });

  it('formats both bounds exactly like Date#toISOString, so TEXT comparison is lexical', () => {
    const { startInclusive, endExclusive } = businessDayBounds({
      from: '2026-10-16',
      to: '2026-10-16',
    });
    expect(new Date(startInclusive).toISOString()).toBe(startInclusive);
    expect(new Date(endExclusive).toISOString()).toBe(endExclusive);
  });

  it.each([
    ['a malformed from', '2026-10-1', '2026-10-16'],
    ['a malformed to', '2026-10-16', 'today'],
    ['to before from', '2026-10-16', '2026-10-15'],
    ['a day outside the supported years', '0999-12-31', '0999-12-31'],
  ])('refuses %s with invalid_day', (_label, from, to) => {
    let caught: unknown;
    try {
      businessDayBounds({ from, to });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BusinessDayError);
    expect((caught as BusinessDayError).code).toBe('invalid_day');
  });
});
