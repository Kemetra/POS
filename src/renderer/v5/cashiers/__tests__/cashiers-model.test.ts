import { describe, expect, it } from 'vitest';

import { CASHIERS_COPY } from '../cashiers-copy';
import { canSavePin, checkPinEntry, formatLockTime, rowActions } from '../cashiers-model';

/**
 * RT-424 (RT-251 doc 19 §3–§5) — the pure rules behind Manager → Cashiers:
 * the state → action matrix, the PIN entry rule and the lock time.
 */

describe('rowActions — the M2–M4 matrix (UX-05: what does not apply is absent)', () => {
  it('no_pin offers only the first PIN', () => {
    expect(rowActions('no_pin')).toEqual({ primary: 'first_pin', secondary: null });
  });

  it('ready offers only change PIN (D1)', () => {
    expect(rowActions('ready')).toEqual({ primary: null, secondary: 'change_pin' });
  });

  it('locked offers unlock and change PIN', () => {
    expect(rowActions('locked')).toEqual({ primary: 'unlock', secondary: 'change_pin' });
  });
});

describe('checkPinEntry / canSavePin — 4–6 digits, typed twice (doc 19 §4)', () => {
  it.each([
    ['1234', '1234'],
    ['123456', '123456'],
    ['١٢٣٤', '1234'],
    ['۱۲۳۴۵', '12345'],
  ])('accepts %s / %s and normalises to Western digits', (first, second) => {
    const res = checkPinEntry(first, second);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.pin).toMatch(/^\d{4,6}$/);
    expect(canSavePin(first, second)).toBe(true);
  });

  it.each([
    ['123', '123'],
    ['1234567', '1234567'],
    ['12a4', '12a4'],
    ['', ''],
    ['12 34', '12 34'],
  ])('refuses a wrong length or a non-digit (%s) with wrong_length', (first, second) => {
    expect(checkPinEntry(first, second)).toEqual({ kind: 'wrong_length' });
    expect(canSavePin(first, second)).toBe(false);
  });

  it('refuses two valid PINs that differ with mismatch, and Save is still enabled', () => {
    expect(checkPinEntry('1234', '4321')).toEqual({ kind: 'mismatch' });
    expect(canSavePin('1234', '4321')).toBe(true);
  });

  it('keeps Save disabled while either field is short', () => {
    expect(canSavePin('1234', '123')).toBe(false);
    expect(canSavePin('123', '1234')).toBe(false);
  });

  it('checks the length of BOTH fields before the match', () => {
    expect(checkPinEntry('1234', '12')).toEqual({ kind: 'wrong_length' });
  });
});

describe('formatLockTime — «حتى ‹HH:MM›», Western digits (D3)', () => {
  it('formats the local wall-clock time as HH:MM, 24-hour', () => {
    const iso = new Date(2026, 9, 12, 14, 35, 10).toISOString();
    expect(formatLockTime(iso)).toBe('14:35');
  });

  it('pads the hour and the minute', () => {
    const iso = new Date(2026, 9, 12, 9, 5, 0).toISOString();
    expect(formatLockTime(iso)).toBe('09:05');
  });

  it('answers null for an unparseable value, so no time is shown', () => {
    expect(formatLockTime('not-a-date')).toBeNull();
  });
});

describe('CASHIERS_COPY — the doc 19 §5 table', () => {
  it('carries the approved strings exactly', () => {
    expect(CASHIERS_COPY.title).toBe('إدارة الكاشير');
    expect(CASHIERS_COPY.unreachable).toBe('تعذّر تحميل قائمة الكاشير. تحقق من الاتصال.');
    expect(CASHIERS_COPY.retry).toBe('إعادة المحاولة');
    expect(CASHIERS_COPY.mismatch).toBe('الرقمان غير متطابقين.');
    expect(CASHIERS_COPY.badge).toEqual({
      no_pin: 'بدون رقم سري',
      ready: 'جاهز',
      locked: 'مقفل',
    });
    expect(CASHIERS_COPY.action).toEqual({
      first_pin: 'تعيين أول رقم سري',
      change_pin: 'تغيير الرقم السري',
      unlock: 'فك القفل',
    });
  });

  it('carries the proposed strings the owner approved with the references', () => {
    expect(CASHIERS_COPY.subtitle).toBe('الرقم السري لكل كاشير على الجهاز');
    expect(CASHIERS_COPY.listHeading).toBe('الكاشير في هذا الفرع');
    expect(CASHIERS_COPY.count(6)).toBe('6 كاشير');
    expect(CASHIERS_COPY.loading).toBe('جارٍ تحميل القائمة…');
    expect(CASHIERS_COPY.refused).toBe('تعذّر تحميل قائمة الكاشير.');
    expect(CASHIERS_COPY.empty).toBe('لا يوجد كاشير مسجّل في هذا الفرع.');
    expect(CASHIERS_COPY.lockedUntil).toBe('حتى');
    expect(CASHIERS_COPY.save).toBe('حفظ');
    expect(CASHIERS_COPY.cancel).toBe('إلغاء');
    expect(CASHIERS_COPY.dialogTitle).toEqual({
      first_pin: 'تعيين أول رقم سري لـ',
      change_pin: 'تغيير الرقم السري لـ',
    });
    expect(CASHIERS_COPY.newPin).toBe('الرقم السري الجديد');
    expect(CASHIERS_COPY.confirmPin).toBe('تأكيد الرقم السري');
    expect(CASHIERS_COPY.hint).toBe('من 4 إلى 6 أرقام.');
    expect(CASHIERS_COPY.wrongLength).toBe('الرقم السري من 4 إلى 6 أرقام.');
    expect(CASHIERS_COPY.done).toEqual({
      first_pin: 'تم تعيين الرقم السري لـ',
      change_pin: 'تم تغيير الرقم السري لـ',
      unlock: 'تم فك القفل عن',
    });
    expect(CASHIERS_COPY.failure).toBe('تعذّر تنفيذ العملية. حاول مرة أخرى.');
    expect(CASHIERS_COPY.notReady).toBe('لا يمكن تفعيل هذا الكاشير الآن. تواصل مع المشرف.');
  });

  it('no string carries an English word or a refusal category', () => {
    const values = (v: unknown): string[] =>
      typeof v === 'string'
        ? [v]
        : typeof v === 'object' && v !== null
          ? Object.values(v).flatMap(values)
          : [];
    const strings = [...values(CASHIERS_COPY), CASHIERS_COPY.count(3)];
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) expect(s).not.toMatch(/[A-Za-z]/);
  });
});
