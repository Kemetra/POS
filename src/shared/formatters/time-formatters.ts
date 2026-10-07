/**
 * Relative-time formatting for receipt/banner surfaces (008 Slice 4).
 *
 * `formatRelativeTime` renders the «منذ ساعتين» part of «آخر فتح: …» for the
 * `<DrawerFailureBanner>` (§A1 brief sub-item (g)). Constraints:
 *
 *   • Arabic only (RT-240): the banner has no English half. Counts follow the
 *     Arabic plural categories (`Intl.PluralRules('ar')`, via
 *     `pluralAr`): one and two have their own words, 3-10 take the plural,
 *     11 and above take the singular.
 *
 *   • Latin digits only (FR-066) — the output is built from JS number literals,
 *     which are always ASCII, so it is digit-safe regardless of locale.
 *   • `now` is injected (never `Date.now()`) — the renderer passes a stable
 *     reference and the function stays pure/deterministic under test.
 *   • Null / unparseable input returns a safe «غير معروف» fallback, never throws
 *     (the banner must render even with a missing/corrupt timestamp).
 *   • A future `iso` (clock skew) clamps to «الآن», never "in N minutes".
 */

import { pluralAr } from './arabic-plural.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The Arabic noun forms of one unit, per plural category (RT-258 / UX-12). */
interface UnitForms {
  readonly one: string;
  readonly two: string;
  /** 3-10. */
  readonly few: string;
  /** 11-99 (and 100+, which Arabic counts like 11-99 for these nouns). */
  readonly many: string;
}

const MINUTES: UnitForms = { one: 'دقيقة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' };
const HOURS: UnitForms = { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' };
const DAYS: UnitForms = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يومًا' };

const UNKNOWN = 'غير معروف';

function ago(n: number, unit: UnitForms): string {
  return pluralAr(n, {
    one: `منذ ${unit.one}`,
    two: `منذ ${unit.two}`,
    few: `منذ {n} ${unit.few}`,
    many: `منذ {n} ${unit.many}`,
    other: `منذ {n} ${unit.many}`,
  });
}

/**
 * @param iso  An ISO-8601 UTC timestamp, or null (e.g. a drawer that never
 *             successfully opened on this terminal).
 * @param now  The reference "now" as an ISO-8601 string (injected for purity).
 */
export function formatRelativeTime(iso: string | null, now: string): string {
  if (iso === null || iso === '') return UNKNOWN;
  const then = Date.parse(iso);
  const ref = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(ref)) return UNKNOWN;

  // Clock skew / future timestamp → clamp to «الآن».
  const deltaMs = ref - then;
  if (deltaMs < MINUTE_MS) return 'الآن';

  if (deltaMs < HOUR_MS) return ago(Math.floor(deltaMs / MINUTE_MS), MINUTES);
  if (deltaMs < DAY_MS) return ago(Math.floor(deltaMs / HOUR_MS), HOURS);
  const days = Math.floor(deltaMs / DAY_MS);
  return days === 1 ? 'أمس' : ago(days, DAYS);
}
