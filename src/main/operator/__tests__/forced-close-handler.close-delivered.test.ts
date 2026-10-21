import { describe, expect, it, vi } from 'vitest';

import { ForcedCloseHandler } from '../forced-close-handler.js';
import type { ForcedCloseHandlerDeps } from '../forced-close-handler.js';
import type { ForceCloseShiftRequest } from '../../../shared/bridge-api.js';

/**
 * RT-772 slice 2 — a manager's forced close is a safe-point trigger for an update install, but
 * only once the close has been delivered: the handler drains the shift outbox and then answers
 * its caller, and an install quits the app. `onCloseDelivered` fires after that delivery has
 * finished (sent or queued), never before, and never for a refused close.
 */

const REQUEST: ForceCloseShiftRequest = {
  event_id: '0190aaaa-0000-7000-8000-000000000001',
  shift_id: '0190aaaa-0000-7000-8000-0000000000aa',
  reason: 'terminal_failure',
  counted_cash_minor: 1000,
};

const MANAGER = {
  id: 'session-1',
  operator_id: 'op-1',
  role: 'manager',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  manager_user_id: 'user-1',
};

function build(
  overrides: {
    deliverNow?: () => Promise<boolean>;
    forceCloseShift?: () => unknown;
    recorded?: boolean;
    session?: unknown;
  } = {},
) {
  const order: string[] = [];
  const onCloseDelivered = vi.fn(() => {
    order.push('delivered-hook');
  });
  const deps = {
    db: {
      prepare: () => ({ get: () => (overrides.recorded === true ? { '1': 1 } : undefined) }),
    },
    sessionManager: { getCurrent: () => ('session' in overrides ? overrides.session : MANAGER) },
    pairingStore: { getStatus: () => Promise.resolve({ kind: 'paired', terminal_id: 'term-1' }) },
    auditEmitter: { emit: vi.fn() },
    shiftCashup: {
      forceCloseShift: vi.fn(
        overrides.forceCloseShift ??
          (() => {
            order.push('closed');
            return { shiftId: REQUEST.shift_id, openingUserId: 'u' };
          }),
      ),
    },
    ...(overrides.deliverNow === undefined ? {} : { deliverNow: overrides.deliverNow }),
    onCloseDelivered,
  } as unknown as ForcedCloseHandlerDeps;
  return { handler: new ForcedCloseHandler(deps), onCloseDelivered, order };
}

describe('onCloseDelivered', () => {
  it('fires after the drain finished, not while it is still running', async () => {
    let finishDrain: (sent: boolean) => void = () => undefined;
    const { handler, onCloseDelivered, order } = build({
      deliverNow: () =>
        new Promise<boolean>((resolve) => {
          order.push('drain-started');
          finishDrain = resolve;
        }),
    });
    const pending = handler.forceCloseShift(REQUEST);
    await vi.waitFor(() => {
      expect(order).toContain('drain-started');
    });
    expect(onCloseDelivered).not.toHaveBeenCalled();
    finishDrain(true);
    await expect(pending).resolves.toMatchObject({ kind: 'forced_closed', delivery: 'sent' });
    expect(onCloseDelivered).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['closed', 'drain-started', 'delivered-hook']);
  });

  it('fires when the drain fails (the close is durable and queued)', async () => {
    const { handler, onCloseDelivered } = build({
      deliverNow: () => Promise.reject(new Error('offline')),
    });
    await expect(handler.forceCloseShift(REQUEST)).resolves.toMatchObject({ delivery: 'queued' });
    expect(onCloseDelivered).toHaveBeenCalledTimes(1);
  });

  it('fires when there is no drain at all', async () => {
    const { handler, onCloseDelivered } = build();
    await expect(handler.forceCloseShift(REQUEST)).resolves.toMatchObject({ delivery: 'queued' });
    expect(onCloseDelivered).toHaveBeenCalledTimes(1);
  });

  it('fires for an idempotent replay too (the close is already committed)', async () => {
    const { handler, onCloseDelivered } = build({ recorded: true });
    await expect(handler.forceCloseShift(REQUEST)).resolves.toMatchObject({
      kind: 'forced_closed',
    });
    expect(onCloseDelivered).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a refused close', async () => {
    const refused = build({
      forceCloseShift: () => {
        throw new Error('anything');
      },
    });
    await expect(refused.handler.forceCloseShift(REQUEST)).resolves.toMatchObject({
      kind: 'refused',
    });
    const signedOut = build({ session: null });
    await expect(signedOut.handler.forceCloseShift(REQUEST)).resolves.toMatchObject({
      kind: 'refused',
    });
    expect(refused.onCloseDelivered).not.toHaveBeenCalled();
    expect(signedOut.onCloseDelivered).not.toHaveBeenCalled();
  });

  it('never fails the answer when the hook throws, and works without a hook', async () => {
    const { handler, onCloseDelivered } = build();
    onCloseDelivered.mockImplementation(() => {
      throw new Error('hook failed');
    });
    await expect(handler.forceCloseShift(REQUEST)).resolves.toMatchObject({
      kind: 'forced_closed',
    });

    const deps = {
      db: { prepare: () => ({ get: () => undefined }) },
      sessionManager: { getCurrent: () => MANAGER },
      pairingStore: { getStatus: () => Promise.resolve({ kind: 'unpaired' }) },
      auditEmitter: { emit: vi.fn() },
      shiftCashup: { forceCloseShift: vi.fn(() => ({ shiftId: REQUEST.shift_id })) },
    } as unknown as ForcedCloseHandlerDeps;
    await expect(new ForcedCloseHandler(deps).forceCloseShift(REQUEST)).resolves.toMatchObject({
      kind: 'forced_closed',
    });
  });
});
