import { pluralAr, type ArabicPluralForms } from '../../../../shared/formatters/arabic-plural';
import { STUCK_SHIFTS_COPY } from './stuck-shifts-copy';

/**
 * RT-502 — pure helpers for the stuck-shifts screen: the cashier name as
 * shown, and how long a shift has been open, in Arabic with the RT-258 plural
 * categories. The noun forms follow `shared/formatters/time-formatters.ts`
 * (genitive after «منذ»): one and two have their own words, 3–10 take the
 * plural, 11 and above the singular.
 */

const MINUTES: ArabicPluralForms = {
  one: 'دقيقة',
  two: 'دقيقتين',
  few: '{n} دقائق',
  many: '{n} دقيقة',
  other: '{n} دقيقة',
};

const HOURS: ArabicPluralForms = {
  one: 'ساعة',
  two: 'ساعتين',
  few: '{n} ساعات',
  many: '{n} ساعة',
  other: '{n} ساعة',
};

/**
 * «45 دقيقة» · «ساعة و5 دقائق» · «3 ساعات و10 دقائق» · «أقل من دقيقة».
 * Whole minutes only; zero minutes after the hours are left out («ساعتين»).
 */
export function formatOpenFor(durationMinutes: number): string {
  const total = Math.floor(durationMinutes);
  if (!(total >= 1)) return STUCK_SHIFTS_COPY.lessThanMinute;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return pluralAr(minutes, MINUTES);
  const head = pluralAr(hours, HOURS);
  return minutes === 0 ? head : `${head} و${pluralAr(minutes, MINUTES)}`;
}

/**
 * The name as shown everywhere (row, initial, dialog title). An empty or
 * missing name gets the fallback, the same test as before (`name || …`).
 */
export function displayNameOf(name: string | null | undefined): string {
  return typeof name === 'string' && name.length > 0 ? name : STUCK_SHIFTS_COPY.unnamed;
}

/** The row's initial: the first letter of the shown name. */
export function initialOf(shownName: string): string {
  return shownName.trim().charAt(0);
}
