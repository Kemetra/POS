/**
 * RT-249 N-S5 — the store-zone date and time of an instant, `YYYY-MM-DD HH:MM`
 * (24-hour, Africa/Cairo), for the receipt stamp. Like the business day, it must
 * not depend on the process `TZ` or the Windows zone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BusinessDayError, businessDateTimeOf, businessDayOf } from '../business-day.js';

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  // [label, instant, expected Cairo date-time]
  ['RT-249 golden: 01:53 Cairo (summer)', '2026-10-06T22:53:00.000Z', '2026-10-07 01:53'],
  ['winter: 00:05 after Cairo midnight (UTC+2)', '2026-01-14T22:05:00.000Z', '2026-01-15 00:05'],
  ['winter: one minute before Cairo midnight', '2026-01-14T21:59:59.999Z', '2026-01-14 23:59'],
  ['summer: Cairo midnight exactly (UTC+3)', '2026-07-14T21:00:00.000Z', '2026-07-15 00:00'],
  ['summer: 02:30 Cairo, still the UTC day before', '2026-07-14T23:30:00.000Z', '2026-07-15 02:30'],
  ['summer-time end: first 23:30 (UTC+3)', '2026-10-29T20:30:00.000Z', '2026-10-29 23:30'],
  ['summer-time end: second 23:30 (UTC+2)', '2026-10-29T21:30:00.000Z', '2026-10-29 23:30'],
  ['seconds are dropped, never rounded', '2026-01-15T08:42:59.999Z', '2026-01-15 10:42'],
];

describe.each(['UTC', 'America/New_York', 'Africa/Cairo'])(
  'businessDateTimeOf under TZ=%s',
  (zone) => {
    let savedTz: string | undefined;

    beforeEach(() => {
      savedTz = process.env.TZ;
      process.env.TZ = zone;
    });

    afterEach(() => {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    });

    it('really runs in that process zone', () => {
      const local = new Date('2026-01-15T23:30:00.000Z').getDate();
      expect(local).toBe(zone === 'Africa/Cairo' ? 16 : 15);
    });

    it.each(CASES)('%s', (_label, instant, expected) => {
      expect(businessDateTimeOf(instant)).toBe(expected);
    });

    it('its date part is always the business day of the instant', () => {
      for (const [, instant] of CASES) {
        expect(businessDateTimeOf(instant).slice(0, 10)).toBe(businessDayOf(instant));
      }
    });
  },
);

describe('businessDateTimeOf refusals', () => {
  it.each(['not-a-date', '2026-01-15T10:00:00', '2026-02-30T10:00:00Z'])(
    'refuses %s rather than guessing',
    (instant) => {
      expect(() => businessDateTimeOf(instant)).toThrow(BusinessDayError);
    },
  );
});
