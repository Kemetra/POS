import { describe, expect, it, vi } from 'vitest';

import { notifyOnShiftClose } from '../compose-shift-cashup.js';
import type { ShiftCashupService } from '../shift-cashup-service.js';

/**
 * RT-772 slice 2 — shift close is one of the two safe-point triggers for an
 * update install. The cashier's close is notified by a decorator on the service; a manager's
 * forced close is notified by its handler after delivery (see forced-close-handler tests).
 * It fires only after a close is committed, and it can never fail one.
 */

function fakeService() {
  const calls: string[] = [];
  const service = {
    openShift: vi.fn(() => {
      calls.push('openShift');
      return { shiftId: 'opened' };
    }),
    recordCashMovement: vi.fn(() => {
      calls.push('recordCashMovement');
      return { movementId: 'm' };
    }),
    closeShift: vi.fn(() => {
      calls.push('closeShift');
      return { shiftId: 'closed' };
    }),
    forceCloseShift: vi.fn(() => {
      calls.push('forceCloseShift');
      return { shiftId: 'forced' };
    }),
    verifyApprover: vi.fn(() => Promise.resolve(null)),
    listApprovers: vi.fn(() => []),
    readStatus: vi.fn(() => Promise.resolve({})),
  };
  return { service: service as unknown as ShiftCashupService, raw: service, calls };
}

describe('notifyOnShiftClose', () => {
  it('notifies after a normal close and returns the close result unchanged', () => {
    const { service, calls } = fakeService();
    const onClosed = vi.fn(() => calls.push('notified'));
    const wrapped = notifyOnShiftClose(service, onClosed);
    expect(wrapped.closeShift({} as never)).toEqual({ shiftId: 'closed' });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['closeShift', 'notified']);
  });

  it('does not notify for a manager forced close: its handler notifies after delivery', () => {
    const { service, calls } = fakeService();
    const onClosed = vi.fn(() => calls.push('notified'));
    const wrapped = notifyOnShiftClose(service, onClosed);
    expect(wrapped.forceCloseShift({} as never)).toEqual({ shiftId: 'forced' });
    expect(calls).toEqual(['forceCloseShift']);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('does not notify when the close fails, and the failure still propagates', () => {
    const { service, raw } = fakeService();
    raw.closeShift.mockImplementation(() => {
      throw new Error('shift_not_open');
    });
    raw.forceCloseShift.mockImplementation(() => {
      throw new Error('shift_not_open');
    });
    const onClosed = vi.fn();
    const wrapped = notifyOnShiftClose(service, onClosed);
    expect(() => wrapped.closeShift({} as never)).toThrow('shift_not_open');
    expect(() => wrapped.forceCloseShift({} as never)).toThrow('shift_not_open');
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('never turns a committed close into a failure when the notification throws', () => {
    const { service } = fakeService();
    const wrapped = notifyOnShiftClose(service, () => {
      throw new Error('update service exploded');
    });
    expect(wrapped.closeShift({} as never)).toEqual({ shiftId: 'closed' });
    expect(wrapped.forceCloseShift({} as never)).toEqual({ shiftId: 'forced' });
  });

  it('passes every other operation straight through without notifying', async () => {
    const { service, raw } = fakeService();
    const onClosed = vi.fn();
    const wrapped = notifyOnShiftClose(service, onClosed);
    expect(wrapped.openShift({} as never)).toEqual({ shiftId: 'opened' });
    expect(wrapped.recordCashMovement({} as never)).toEqual({ movementId: 'm' });
    await expect(wrapped.verifyApprover({} as never)).resolves.toBeNull();
    expect(wrapped.listApprovers()).toEqual([]);
    await expect(wrapped.readStatus()).resolves.toEqual({});
    expect(raw.openShift).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
  });
});
