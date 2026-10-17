import { describe, expect, it } from 'vitest';

import { CART_PARK_REFUSAL_REASONS } from '../../../../shared/cart/park-types';
import { RECOVERY_COPY } from '../../recovery/recovery-copy';
import {
  PARK_COPY,
  conflictLead,
  itemsLabel,
  parkRefusalView,
  parkedTime,
  terminalParkedCount,
} from '../park-copy';

/** RT-445 — the park / resume copy as drawn (PK3-Spec.html) and decided (RT-471 OD-1…OD-15). */
describe('park copy', () => {
  it('counts items as drawn: «صنف واحد», «صنفان», «N أصناف»', () => {
    expect(itemsLabel(1)).toBe('صنف واحد');
    expect(itemsLabel(2)).toBe('صنفان');
    expect(itemsLabel(4)).toBe('4 أصناف');
  });

  it('OD-13: the shift-close count, singular, dual and plural, terminal-wide', () => {
    expect(terminalParkedCount(1)).toBe('بيع معلّق واحد على هذا الجهاز');
    expect(terminalParkedCount(2)).toBe('بيعان معلّقان على هذا الجهاز');
    expect(terminalParkedCount(3)).toBe('3 مبيعات معلّقة على هذا الجهاز');
  });

  it('VN-R10: the conflict sentence names the line count before the amount', () => {
    expect(conflictLead(2)).toBe('لديك بيع نشط الآن: صنفان بقيمة');
  });

  it('OD-12: «HH:MM» for today, «DD/MM HH:MM» for an earlier day, in the store zone', () => {
    const now = new Date('2026-10-17T12:00:00Z'); // 15:00 in Cairo
    expect(parkedTime('2026-10-17T10:41:00Z', now)).toBe('13:41');
    expect(parkedTime('2026-10-16T17:45:00Z', now)).toBe('16/10 20:45');
    // Just after Cairo midnight is still "today" there, though it is yesterday in UTC.
    expect(parkedTime('2026-10-16T21:30:00Z', now)).toBe('00:30');
    expect(parkedTime('not a time', now)).toBe('not a time');
  });

  it('OD-9: every refusal maps; the undrawn reasons share the generic line', () => {
    const drawn = new Set([
      'invalid_label',
      'park_limit_reached',
      'catalogue_unavailable',
      'price_changes_unaccepted',
      'checkout_in_progress',
      'session_locked',
    ]);
    for (const reason of CART_PARK_REFUSAL_REASONS) {
      expect(parkRefusalView(reason)).toBe(drawn.has(reason) ? reason : 'generic');
    }
    expect(PARK_COPY.generic).toBe('تعذّر تنفيذ العملية. حاول مرة أخرى، وإن تكرر اطلب المدير.');
  });

  it('OD-2: the term is «معلّق» everywhere, the manager recovery tag included', () => {
    expect(RECOVERY_COPY.parked).toBe('معلّقة');
    const all = [...Object.values(PARK_COPY), RECOVERY_COPY.parked].join(' ');
    expect(all).not.toMatch(/مؤجل/);
  });
});
