/**
 * RT-550 (RT-545 S1) — the one store business-day rule, shared by the Electron
 * main process and the renderer (platform `Intl` only; no Node or DOM API).
 *
 * The store zone is a build constant: Africa/Cairo for the pilot (RT-545
 * decision 12085 item 3). It is deliberately not read from the environment,
 * settings or the Windows zone, so the day of an instant cannot depend on the
 * machine. Backend-Core computes `business_date` in the store zone; this must
 * agree with it.
 */

/** The pilot store's IANA zone. One constant; no env or settings lookup. */
export const STORE_TIME_ZONE = 'Africa/Cairo';

export type BusinessDayErrorCode = 'invalid_instant';

/** Thrown for an instant that is not a valid, unambiguous point in time. */
export class BusinessDayError extends Error {
  readonly code: BusinessDayErrorCode;

  constructor(code: BusinessDayErrorCode, message: string) {
    super(message);
    this.name = 'BusinessDayError';
    this.code = code;
  }
}

/**
 * ISO-8601 date-time with a mandatory zone designator. A string without one
 * would be read in the process zone by `Date`, which is exactly the
 * dependence this module exists to remove, so it is refused.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const STORE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: STORE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function invalid(detail: string): BusinessDayError {
  return new BusinessDayError('invalid_instant', `Invalid instant: ${detail}`);
}

/**
 * Assembles `YYYY-MM-DD` from the formatter's parts, so the result does not
 * rely on a locale's field order or separators. Null when a part is missing
 * or out of the 4-digit year range (the formatter does not pad such years).
 */
function dayFromParts(date: Date): string | null {
  const parts = new Map(STORE_DAY.formatToParts(date).map((part) => [part.type, part.value]));
  const year = parts.get('year');
  const month = parts.get('month');
  const day = parts.get('day');
  if (year === undefined || month === undefined || day === undefined) return null;
  const complete = /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day);
  return complete ? `${year}-${month}-${day}` : null;
}

/** True when `year-month-day` is a real calendar date (no V8 roll-over). */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  // `Date.UTC` maps years 0-99 to 1900-1999, so set the full year explicitly.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function parseInstant(instant: string): Date {
  const match = ISO_INSTANT.exec(instant);
  if (match === null) throw invalid('expected an ISO-8601 date-time with a zone offset');
  if (!isRealCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw invalid('not a real calendar date');
  }
  return new Date(instant);
}

function toDate(instant: string | Date): Date {
  if (instant instanceof Date) return instant;
  if (typeof instant === 'string') return parseInstant(instant);
  throw invalid('expected an ISO-8601 string or a Date');
}

/**
 * The store business day (`YYYY-MM-DD`, in {@link STORE_TIME_ZONE}) of an
 * instant. Accepts an ISO-8601 string with a zone offset, or a `Date`.
 * DST-correct: it converts the instant, it never adds a fixed offset.
 *
 * @throws {BusinessDayError} `invalid_instant` for anything that is not a
 *   valid instant — never coerced to a day.
 */
export function businessDayOf(instant: string | Date): string {
  const date = toDate(instant);
  if (Number.isNaN(date.getTime())) throw invalid('not a valid date');
  const day = dayFromParts(date);
  if (day === null) throw invalid('outside the supported year range');
  return day;
}
