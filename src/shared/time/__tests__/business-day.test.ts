/**
 * RT-550 (RT-545 S1) — the shared store business-day rule. The store zone is a
 * build constant (Africa/Cairo for the pilot); the day of an instant must not
 * depend on the process `TZ` or the Windows zone. Egypt observes summer time
 * (UTC+3) from the last Friday of April to the last Thursday of October, else
 * UTC+2.
 */
import { describe, expect, it } from 'vitest';

import { BusinessDayError, STORE_TIME_ZONE, businessDayOf } from '../business-day.js';

/** One test per [label, instant, expected Cairo day] row. */
function expectDays(rows: ReadonlyArray<readonly [string, string, string]>): void {
  it.each(rows)('%s', (_label, instant, expected) => {
    expect(businessDayOf(instant)).toBe(expected);
  });
}

describe('STORE_TIME_ZONE', () => {
  it('is Africa/Cairo for the pilot', () => {
    expect(STORE_TIME_ZONE).toBe('Africa/Cairo');
  });
});

describe('businessDayOf', () => {
  expectDays([
    // [label, instant, expected Cairo day]
    ['N-10: UTC day behind Cairo (summer, 01:53 local)', '2026-10-06T22:53:00Z', '2026-10-07'],
    ['winter: just before Cairo midnight (UTC+2)', '2026-01-14T21:59:59.999Z', '2026-01-14'],
    ['winter: Cairo midnight exactly (UTC+2)', '2026-01-14T22:00:00Z', '2026-01-15'],
    ['summer: just before Cairo midnight (UTC+3)', '2026-07-14T20:59:59.999Z', '2026-07-14'],
    ['summer: Cairo midnight exactly (UTC+3)', '2026-07-14T21:00:00Z', '2026-07-15'],
    ['UTC midnight is 02:00 Cairo in winter, same day', '2026-01-15T00:00:00Z', '2026-01-15'],
    ['UTC 22:30 is the next Cairo day in winter', '2026-01-14T22:30:00Z', '2026-01-15'],
    ['explicit +02:00 offset is the same instant', '2026-01-15T00:00:00+02:00', '2026-01-15'],
    ['explicit -05:00 offset converts first', '2026-01-14T18:00:00-05:00', '2026-01-15'],
    ['year end rolls the year', '2026-12-31T22:00:00Z', '2027-01-01'],
    ['leap day (Cairo winter)', '2028-02-28T22:00:00Z', '2028-02-29'],
  ]);

  describe('summer-time end, Thu 2026-10-29 (23:00-24:00 local repeats)', () => {
    // 2026-10-29 00:00 +03:00 = 2026-10-28T21:00Z. At 24:00 summer time the
    // clocks go back to 23:00, so local 23:00-24:00 occurs twice.
    expectDays([
      ['first 23:30 (UTC+3)', '2026-10-29T20:30:00Z', '2026-10-29'],
      ['second 23:30 (UTC+2)', '2026-10-29T21:30:00Z', '2026-10-29'],
      ['last instant of the day (UTC+2)', '2026-10-29T21:59:59.999Z', '2026-10-29'],
      ['first instant of the next day', '2026-10-29T22:00:00Z', '2026-10-30'],
      ['first instant of the day', '2026-10-28T21:00:00Z', '2026-10-29'],
      ['just before the day starts', '2026-10-28T20:59:59.999Z', '2026-10-28'],
    ]);
  });

  describe('summer-time start, Fri 2026-04-24 (00:00-01:00 local is skipped)', () => {
    expectDays([
      ['last winter instant (23:59:59.999 local)', '2026-04-23T21:59:59.999Z', '2026-04-23'],
      ['first summer instant (01:00 local)', '2026-04-23T22:00:00Z', '2026-04-24'],
      ['the day after, midnight (UTC+3)', '2026-04-24T21:00:00Z', '2026-04-25'],
      ['the day after, just before midnight', '2026-04-24T20:59:59.999Z', '2026-04-24'],
    ]);
  });

  describe('Date input', () => {
    it('accepts a Date and agrees with the equivalent ISO string', () => {
      const iso = '2026-10-06T22:53:00.000Z';
      expect(businessDayOf(new Date(iso))).toBe(businessDayOf(iso));
      expect(businessDayOf(new Date(iso))).toBe('2026-10-07');
    });
  });

  describe('UTC and Cairo disagree', () => {
    it.each<[string, string, string]>([
      ['winter, 22:00-23:59 UTC', '2026-01-14T23:59:59Z', '2026-01-15'],
      ['summer, 21:00-23:59 UTC', '2026-07-14T23:59:59Z', '2026-07-15'],
    ])('%s: Cairo is ahead of the UTC date', (_label, instant, expected) => {
      expect(instant.slice(0, 10)).not.toBe(expected);
      expect(businessDayOf(instant)).toBe(expected);
    });
  });

  describe('invalid input', () => {
    it.each<[string, unknown]>([
      ['not-a-date string', 'not-a-date'],
      ['empty string', ''],
      ['whitespace string', '   '],
      ['invalid Date', new Date(Number.NaN)],
      ['calendar date without time', '2026-10-06'],
      ['local time without an offset (zone-dependent)', '2026-10-06T22:53:00'],
      ['non-ISO date text', 'October 6, 2026 22:53 UTC'],
      ['month 13', '2026-13-01T00:00:00Z'],
      ['day 32', '2026-01-32T00:00:00Z'],
      ['hour 25', '2026-01-01T25:00:00Z'],
      ['impossible calendar day', '2026-02-30T00:00:00Z'],
      ['number', 1_790_000_000_000],
      ['null', null],
      ['undefined', undefined],
      ['object', {}],
    ])('refuses %s with a typed error', (_label, input) => {
      expect(() => businessDayOf(input as string)).toThrow(BusinessDayError);
    });

    it('carries a stable error name and code', () => {
      try {
        businessDayOf('not-a-date');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as BusinessDayError).name).toBe('BusinessDayError');
        expect((error as BusinessDayError).code).toBe('invalid_instant');
      }
    });
  });

  describe('independent of the process time zone', () => {
    const CASES: ReadonlyArray<readonly [string, string]> = [
      ['2026-10-06T22:53:00Z', '2026-10-07'],
      ['2026-01-14T21:59:59.999Z', '2026-01-14'],
      ['2026-01-14T22:00:00Z', '2026-01-15'],
      ['2026-10-29T21:30:00Z', '2026-10-29'],
      ['2026-04-23T22:00:00Z', '2026-04-24'],
    ];

    it.each(['UTC', 'America/New_York', 'America/Los_Angeles', 'Pacific/Kiritimati'])(
      'gives the same days under TZ=%s',
      (zone) => {
        const previous = process.env.TZ;
        process.env.TZ = zone;
        try {
          for (const [instant, expected] of CASES) {
            expect(businessDayOf(instant)).toBe(expected);
            expect(businessDayOf(new Date(instant))).toBe(expected);
          }
        } finally {
          if (previous === undefined) delete process.env.TZ;
          else process.env.TZ = previous;
        }
      },
    );
  });

  describe('accepted ISO shapes', () => {
    expectDays([
      [
        'fractional seconds longer than 3 digits truncate',
        '2026-01-14T21:59:59.999999Z',
        '2026-01-14',
      ],
      ['no seconds', '2026-01-14T22:00Z', '2026-01-15'],
      ['extreme positive offset +23:59', '2026-01-15T23:00:00+23:59', '2026-01-15'],
      ['-00:00 is UTC', '2026-01-14T22:00:00-00:00', '2026-01-15'],
    ]);
  });

  describe('refused shapes and years', () => {
    it.each<[string, string]>([
      ['lowercase t/z', '2026-01-14t22:00:00z'],
      ['offset without a colon', '2026-01-14T22:00:00+0200'],
      ['leap second', '2026-06-30T23:59:60Z'],
      ['hour 24', '2026-01-14T24:00:00Z'],
      ['trailing newline', '2026-01-14T22:00:00Z\n'],
      ['year 0050 (not 1950)', '0050-01-01T12:00:00Z'],
      ['year 0999 (unpadded output)', '0999-01-01T12:00:00Z'],
      ['year 10000 after conversion', '9999-12-31T23:00:00Z'],
    ])('refuses %s', (_label, instant) => {
      expect(() => businessDayOf(instant)).toThrow(BusinessDayError);
    });

    it('refuses a BCE Date instead of returning a false CE day', () => {
      const bce = new Date(0);
      bce.setUTCFullYear(-999, 0, 1);
      expect(() => businessDayOf(bce)).toThrow(BusinessDayError);
    });

    it('refuses an extreme Date outside the formattable range', () => {
      expect(() => businessDayOf(new Date(8.64e15))).toThrow(BusinessDayError);
    });
  });

  it('never mutates its Date argument', () => {
    const date = new Date('2026-10-06T22:53:00.000Z');
    const before = date.getTime();
    businessDayOf(date);
    expect(date.getTime()).toBe(before);
  });
});
