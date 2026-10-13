/**
 * RT-443 (MA-2) — `approval:*` IPC: closed shapes validated before the
 * service, generic `invalid_input` otherwise, an unexpected failure logged by
 * name only (never the PIN) and answered `approval_unavailable`, and both
 * channels refused while the session is locked.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  readApprovalRequest,
  readListApproversRequest,
  registerManagerApprovalHandlers,
} from '../manager-approval.js';
import { MANAGER_APPROVAL_IPC_CHANNELS } from '../../../shared/operator/manager-approval.js';
import {
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
  createSessionLockGuardedIpcMain,
} from '../session-lock-guard.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const REF = '7f3c1e2a-0b4d-4c5e-8f60-0000000000aa';
const VALID = {
  action_kind: 'cart.cancel_post_handoff',
  subject_ref: 'cart-1',
  reason_code: 'customer_left',
  approver_ref: REF,
  pin: '246810',
} as const;
const INVALID = { kind: 'refused', reason: 'invalid_input' };

function setup(locked = false) {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: vi.fn((channel: string, fn: Listener) => handlers.set(channel, fn)),
    on: () => raw,
  };
  const service = {
    listApprovers: vi.fn(() => ({ kind: 'approvers' as const, approvers: [] })),
    request: vi.fn(() => Promise.resolve({ kind: 'approved' as const, approvalId: 'a-1' })),
  };
  const logger = { warn: vi.fn() };
  registerManagerApprovalHandlers(
    createSessionLockGuardedIpcMain(raw as unknown as IpcMain, () => locked),
    { service, logger },
  );
  const invoke = async (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return await handler({} as IpcMainInvokeEvent, payload);
  };
  return { handlers, invoke, service, logger };
}

describe('approval:* registration', () => {
  it('registers exactly the two channels, neither on the lock allowlist', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(MANAGER_APPROVAL_IPC_CHANNELS).sort(),
    );
    for (const channel of handlers.keys()) expect(LOCKED_ALLOWED_CHANNELS.has(channel)).toBe(false);
  });

  it.each(Object.values(MANAGER_APPROVAL_IPC_CHANNELS))(
    'refuses %s while locked, before the service',
    async (channel) => {
      const { invoke, service } = setup(true);
      await expect(invoke(channel, VALID)).rejects.toBeInstanceOf(SessionLockedError);
      expect(service.request).not.toHaveBeenCalled();
      expect(service.listApprovers).not.toHaveBeenCalled();
    },
  );
});

describe('approval:request', () => {
  it('passes a valid request and answers the opaque approval_id', async () => {
    const { invoke, service } = setup();
    await expect(invoke(MANAGER_APPROVAL_IPC_CHANNELS.REQUEST, VALID)).resolves.toEqual({
      kind: 'approved',
      approval_id: 'a-1',
    });
    expect(service.request).toHaveBeenCalledWith(VALID);
  });

  it('accepts a note of up to 200 characters', () => {
    expect(readApprovalRequest({ ...VALID, reason_note: 'n'.repeat(200) })).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', [VALID]],
    ['an unknown kind', { ...VALID, action_kind: 'drawer.no_sale' }],
    ['a missing kind', { ...VALID, action_kind: undefined }],
    ['an empty subject', { ...VALID, subject_ref: '' }],
    ['a subject with spaces', { ...VALID, subject_ref: 'cart 1' }],
    ['an upper-case reason', { ...VALID, reason_code: 'Customer' }],
    ['a long reason', { ...VALID, reason_code: `a${'b'.repeat(40)}` }],
    ['a long note', { ...VALID, reason_note: 'n'.repeat(201) }],
    ['a numeric note', { ...VALID, reason_note: 7 }],
    ['an upper-case handle', { ...VALID, approver_ref: REF.toUpperCase() }],
    ['a short PIN', { ...VALID, pin: '12345' }],
    ['a long PIN', { ...VALID, pin: '123456789' }],
    ['a numeric PIN', { ...VALID, pin: 246810 }],
    ['a smuggled approver id', { ...VALID, approver_user_id: 'u-1' }],
    ['a smuggled amount', { ...VALID, amount_minor: 1 }],
  ])('refuses %s as invalid_input before the service', async (_l, payload) => {
    const { invoke, service } = setup();
    await expect(invoke(MANAGER_APPROVAL_IPC_CHANNELS.REQUEST, payload)).resolves.toEqual(INVALID);
    expect(service.request).not.toHaveBeenCalled();
  });

  it('answers an unexpected failure as approval_unavailable, logging its name only', async () => {
    const { invoke, service, logger } = setup();
    service.request.mockRejectedValueOnce(new RangeError(`pin ${VALID.pin}`));
    await expect(invoke(MANAGER_APPROVAL_IPC_CHANNELS.REQUEST, VALID)).resolves.toEqual({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { op: 'request', error: 'RangeError' },
      'approval:failed',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(VALID.pin);
  });
});

describe('approval:listApprovers', () => {
  it('takes exactly { action_kind }', async () => {
    const { invoke, service } = setup();
    await invoke(MANAGER_APPROVAL_IPC_CHANNELS.LIST_APPROVERS, {
      action_kind: 'cart.cancel_post_handoff',
    });
    expect(service.listApprovers).toHaveBeenCalledWith({ actionKind: 'cart.cancel_post_handoff' });
    expect(readListApproversRequest({})).toBeNull();
    expect(readListApproversRequest({ action_kind: 'nope' })).toBeNull();
    expect(
      readListApproversRequest({ action_kind: 'cart.cancel_post_handoff', scope: 'all' }),
    ).toBeNull();
  });
});
