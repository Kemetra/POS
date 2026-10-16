/** RT-530 — every refusal reason has its own Arabic message; none leaks an identity. */
import { describe, expect, it } from 'vitest';

import { APPROVAL_REFUSAL_REASONS } from '../../../../shared/operator/manager-approval';
import {
  LOCAL_VOID_REFUSALS,
  SALE_VOID_STATES,
  SERVER_VOID_REFUSALS,
} from '../../../../shared/sale-void/types';
import { VOID_COPY, voidRefusalMessage, voidStateLabel, voidWaitingMessage } from '../void-copy';

describe('void copy', () => {
  it.each([...LOCAL_VOID_REFUSALS, ...SERVER_VOID_REFUSALS, ...APPROVAL_REFUSAL_REASONS])(
    'has its own message for %s, not the generic fallback',
    (reason) => {
      const message = voidRefusalMessage(reason);
      expect(message).toMatch(/[؀-ۿ]/);
      if (reason !== 'void_unavailable') expect(message).not.toBe(VOID_COPY.unavailable);
    },
  );

  it('falls back to the generic message for an unknown reason', () => {
    expect(voidRefusalMessage('something_new')).toBe(VOID_COPY.unavailable);
  });

  it('labels every journal state', () => {
    for (const state of SALE_VOID_STATES) expect(voidStateLabel(state).length).toBeGreaterThan(0);
    expect(new Set(SALE_VOID_STATES.map(voidStateLabel)).size).toBe(SALE_VOID_STATES.length);
  });

  it('names only the requester for a void waiting for their sign-in', () => {
    expect(voidWaitingMessage('requester_sign_in', 'منى المديرة')).toBe(
      'بانتظار تسجيل دخول منى المديرة متصلًا لإرسال الإلغاء',
    );
    expect(voidWaitingMessage('sale_sync', 'منى المديرة')).not.toContain('منى');
  });

  it('tells staff a business day that passed means a return, not a retry', () => {
    expect(voidRefusalMessage('void_outside_business_day')).toContain('المرتجعات');
    expect(voidRefusalMessage('not_same_day')).toContain('المرتجعات');
  });

  it('keeps the four-eyes refusals naming the rule, never a person', () => {
    for (const reason of ['approval_unavailable', 'void_self_approval']) {
      expect(voidRefusalMessage(reason)).toContain('مدير آخر');
    }
  });
});
