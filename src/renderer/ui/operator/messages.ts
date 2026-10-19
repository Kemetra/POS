import type { RefusalCategory } from '../../../shared/audit/event-shape.js';
import { STUCK_SHIFTS_COPY } from '../../v5/manager/stuck-shifts/stuck-shifts-copy.js';

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
  // RT-358 (RT-247 D-A1, UX-12, owner decision 2026-10-07) — the manager's
  // sign-in expired. The only action offered is «تسجيل الدخول», never a retry.
  reauth_required: 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.',
  // RT-444 (RT-116 §4) — names neither the other operator nor any amount (FR-013).
  terminal_has_unresolved_payment:
    'على هذه الطرفية دفع غير مكتمل لموظف آخر. لا يمكن الدخول حتى يعود صاحبه ويكمله.',
  // RT-444 (RT-116 §3.4) — sign-out while the session holds live tender.
  payment_in_progress: 'يوجد دفع جارٍ. أكمل الدفع أو ألغِه قبل تسجيل الخروج.',
  // RT-554 — forced close of a shift opened on another device (not this one).
  not_closable_here: STUCK_SHIFTS_COPY.notClosableHere,
});

export const EMPTY_INPUT_MESSAGE = 'أدخل بيانات الدخول للمتابعة.';

/**
 * RT-358 (RT-247 D-A1, UX-12, owner decision 2026-10-07) — the in-place manager
 * re-auth. The notice text is `SIGN_IN_REFUSAL_COPY.reauth_required`; its ONE
 * action is «تسجيل الدخول» — never a generic retry. Field labels match the
 * manager sign-in form.
 */
export const REAUTH_COPY = Object.freeze({
  action: 'تسجيل الدخول',
  title: 'تسجيل الدخول مرة أخرى',
  managerLabel: 'المدير',
  identifierLabel: 'البريد الإلكتروني أو اسم المستخدم',
  passwordLabel: 'كلمة المرور',
  submit: 'تسجيل الدخول',
  submitting: 'جارٍ تسجيل الدخول…',
  cancel: 'إلغاء',
});
