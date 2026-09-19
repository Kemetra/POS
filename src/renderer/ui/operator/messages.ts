import type { RefusalCategory } from '../../../shared/audit/event-shape.js';

/**
 * 004-operator-session T033 — Surface 6 generic-failure copy.
 *
 * Single generic message family per refusal category (NFR-003 / PR-2).
 * The renderer maps the bridge's RefusalCategory to one of these
 * strings; nothing else is rendered. No factor-distinguishing
 * sub-detail. No interpolated user input.
 *
 * `rate_limited` is the cashier-PIN-lockout exception (PR-2 carve-out).
 * Reachable in S4. The S1 surface never produces it; the string
 * exists here so the mapping is complete and a future S4 reviewer can
 * find the canonical copy in one place.
 *
 * 022 US1 T054 — copy is Arabic-first: the terminal is an Arabic-first
 * product (`<html lang="ar" dir="rtl">`) and an English-only sign-in refusal
 * was one of the inconsistencies 022 exists to remove. The P11 property that
 * matters is UNCHANGED: still exactly one generic message per category, with
 * no factor-distinguishing detail and no interpolated user input — an
 * attacker learns nothing from which string is shown.
 */

export const SIGN_IN_REFUSAL_COPY: Readonly<Record<RefusalCategory, string>> = Object.freeze({
  invalid_input: 'بيانات الدخول غير صحيحة. حاول مرة أخرى.',
  no_connection: 'تعذّر الوصول إلى الخادم. حاول مرة أخرى.',
  rate_limited: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
  role_mismatch: 'لا تملك صلاحية الوصول إلى هذه الشاشة.',
  not_signed_in: 'سجّل الدخول للمتابعة.',
  state_invalid: 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية.',
  // 019-cashier-pin-provisioning FR-11 — truthful degraded state (P9): the
  // cashier has no provider-neutral identifier yet, so provisioning is not
  // possible. Never presented as a failed attempt.
  not_ready: 'لا يمكن تفعيل هذا الكاشير بعد.',
});

export const EMPTY_INPUT_MESSAGE = 'أدخل بيانات الدخول للمتابعة.';
