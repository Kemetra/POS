import type { CartParkRefusalReason } from '../../../shared/cart/park-types';
import { businessDateTimeOf, businessDayOf } from '../../../shared/time/business-day';

/**
 * RT-445 (PK-3, VN-S11) — the park / resume copy. Arabic only, every string
 * as drawn in the frozen references (`docs/design/vnext/visual-acceptance/
 * PK3-Park-Resume/`, PK3-Spec.html) and approved by the owner (RT-471 OD-1…
 * OD-15). The term is «معلّق» everywhere (OD-2). No refusal names an owner, a
 * label or an amount.
 */
export const PARK_COPY = Object.freeze({
  // The Sale screen.
  parkAction: 'تعليق البيع',
  parkedSales: 'المبيعات المعلّقة',
  parkedOk: 'عُلِّق البيع',
  // The park dialog.
  dialogTitle: 'تعليق البيع',
  labelField: 'اسم للبيع (اختياري)',
  pii: 'لا تكتب اسم العميل أو رقم هاتفه أو أي بيانات شخصية.',
  back: 'رجوع',
  saving: 'جارٍ حفظ البيع…',
  invalidLabel: 'اكتب اسمًا من 1 إلى 40 حرفًا في سطر واحد، أو اتركه فارغًا.',
  limit:
    'وصل هذا الجهاز إلى الحد الأقصى: 5 مبيعات معلّقة. استأنف بيعًا معلّقًا أو اطلب من المدير إلغاءه.',
  showParked: 'عرض المبيعات المعلّقة',
  // The parked list.
  listTitle: 'المبيعات المعلّقة',
  listHeading: 'مبيعاتك المعلّقة',
  listNone: 'لا شيء',
  backToSale: 'رجوع إلى البيع',
  listEmpty: 'لا توجد مبيعات معلّقة.',
  unnamed: 'بدون اسم',
  parkedAt: 'عُلّق',
  stale: 'قديم',
  resume: 'استئناف البيع',
  listFoot:
    'تبقى المبيعات المعلّقة على هذا الجهاز ولا تظهر لغير صاحبها. يُراجَع كل سعر عند الاستئناف.',
  // The resume review.
  reviewTitle: 'استئناف البيع',
  backToList: 'رجوع إلى القائمة',
  reviewHeading: 'مراجعة البيع قبل الاستئناف',
  reviewLead: 'لن يتغيّر شيء في البيع قبل أن تقبل التغييرات.',
  changesHeading: 'تغيّر سعر الصنف منذ التعليق',
  changesTable: 'تغيّر الأسعار',
  colItem: 'الصنف',
  colOld: 'السعر السابق',
  colNew: 'السعر الجديد',
  colDiff: 'الفرق للوحدة',
  rose: 'ارتفع',
  fell: 'انخفض',
  removedHeading: 'لم تعد في الكتالوج، وستُحذف من البيع عند الاستئناف',
  removedTable: 'أصناف ستُحذف',
  removedTag: 'ستُحذف',
  freshness: 'آخر كتالوج:',
  today: 'اليوم',
  conflictBody: 'لا يمكن دمج بيعين. اختر ما يحدث للبيع الحالي.',
  acceptChanges: 'قبول التغييرات واستئناف البيع',
  acceptRemoval: 'قبول الحذف واستئناف البيع',
  swap: 'علّق البيع الحالي واستأنف المحدد',
  swapWithChanges: 'علّق الحالي، اقبل التغييرات واستأنف',
  keepCurrent: 'أبقِ البيع الحالي',
  // Refusals (OD-9, OD-14).
  catalogueUnavailable:
    'تعذّرت مراجعة الأسعار لأن الكتالوج غير متاح على هذا الجهاز. بقي البيع معلّقًا ولم يتغيّر شيء.',
  pricesChanged: 'تغيّرت الأسعار منذ عرضها. راجع التغييرات الجديدة قبل الاستئناف.',
  checkoutInProgress:
    'البيع الحالي في مرحلة الدفع. أكمله أو ارجع إليه قبل أن تستأنف بيعًا معلّقًا.',
  generic: 'تعذّر تنفيذ العملية. حاول مرة أخرى، وإن تكرر اطلب المدير.',
  // Shift close (OD-13).
  showMyParked: 'عرض مبيعاتي المعلّقة',
});

/** «صنف واحد» / «صنفان» / «4 أصناف» (as drawn). */
export function itemsLabel(n: number): string {
  if (n === 1) return 'صنف واحد';
  if (n === 2) return 'صنفان';
  return `${String(n)} أصناف`;
}

/** The shift-close blocking count (OD-13): the whole terminal, a count only. */
export function terminalParkedCount(n: number): string {
  if (n === 1) return 'بيع معلّق واحد على هذا الجهاز';
  if (n === 2) return 'بيعان معلّقان على هذا الجهاز';
  return `${String(n)} مبيعات معلّقة على هذا الجهاز`;
}

/**
 * «لديك بيع نشط الآن: صنفان بقيمة 95.00 EGP.» — the words before the amount;
 * the caller isolates the amount (left to right) and ends the sentence.
 */
export function conflictLead(lines: number): string {
  return `لديك بيع نشط الآن: ${itemsLabel(lines)} بقيمة`;
}

/**
 * OD-12: «13:41» for today, «16/10 20:45» for an earlier day, in the store
 * zone (the D-N1 business day). An unreadable instant is shown as it is.
 */
export function parkedTime(instant: string, now: Date = new Date()): string {
  try {
    const stamp = businessDateTimeOf(instant); // YYYY-MM-DD HH:MM
    const [day = '', time = ''] = stamp.split(' ');
    if (day === businessDayOf(now)) return time;
    const [, month = '', date = ''] = day.split('-');
    return `${date}/${month} ${time}`;
  } catch {
    return instant;
  }
}

/** What the UI does with a refusal: a drawn state, the lock screen, or the generic line (OD-9). */
export type ParkRefusalView =
  | 'invalid_label'
  | 'park_limit_reached'
  | 'catalogue_unavailable'
  | 'price_changes_unaccepted'
  | 'checkout_in_progress'
  | 'session_locked'
  | 'generic';

const DRAWN: ReadonlySet<CartParkRefusalReason> = new Set<CartParkRefusalReason>([
  'invalid_label',
  'park_limit_reached',
  'catalogue_unavailable',
  'price_changes_unaccepted',
  'checkout_in_progress',
  'session_locked',
]);

/** Every refusal maps; the reasons with no drawn state share the generic line (OD-9). */
export function parkRefusalView(reason: CartParkRefusalReason): ParkRefusalView {
  return DRAWN.has(reason) ? (reason as ParkRefusalView) : 'generic';
}
