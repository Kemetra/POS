/**
 * RT-15 S4 — `returns:payout` / `returns:reprintSlip` IPC (§A4; invariants I1,
 * M1, A6). The renderer is untrusted: the request is exactly `{ returnId,
 * action }` (or `{ returnId }`), with a canonical UUID and a closed action. No
 * amount, operator, method or anything else can be smuggled in; both channels
 * are refused while the session is locked.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../../shared/returns/channels.js';
import type { ReturnsBridgeAPI } from '../../../shared/returns/types.js';
import { registerReturnsHandlers } from '../returns.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const RETURN_ID = '0190f5a2-7b3c-4d4e-8f90-00000000000a';
const INVALID_PAYOUT = { kind: 'refused', reason: 'invalid_input', ret: null };
const INVALID = { kind: 'refused', reason: 'invalid_input' };

function setup(locked = false) {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: () => raw,
  } as unknown as IpcMain;
  const service = {
    payout: vi.fn(() => Promise.resolve({ kind: 'paid_out' })),
    reprintSlip: vi.fn(() => Promise.resolve({ kind: 'printed' })),
  };
  registerReturnsHandlers(
    createSessionLockGuardedIpcMain(raw, () => locked),
    {
      service: service as unknown as ReturnsBridgeAPI,
    },
  );
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return await handler({} as IpcMainInvokeEvent, ...args);
  };
  return { service, invoke };
}

describe('returns:payout and returns:reprintSlip', () => {
  it.each([RETURNS_IPC_CHANNELS.PAYOUT, RETURNS_IPC_CHANNELS.REPRINT_SLIP])(
    'A6: %s is refused while locked and is not on the allowlist',
    async (channel) => {
      const { invoke, service } = setup(true);
      expect(LOCKED_ALLOWED_CHANNELS.has(channel)).toBe(false);
      await expect(
        invoke(channel, { returnId: RETURN_ID, action: 'start' }),
      ).rejects.toBeInstanceOf(SessionLockedError);
      expect(service.payout).not.toHaveBeenCalled();
      expect(service.reprintSlip).not.toHaveBeenCalled();
    },
  );

  it.each(['start', 'retry_drawer', 'manual'])('I1: forwards a valid %s payout', async (action) => {
    const { invoke, service } = setup();
    await expect(
      invoke(RETURNS_IPC_CHANNELS.PAYOUT, { returnId: RETURN_ID, action }),
    ).resolves.toEqual({
      kind: 'paid_out',
    });
    expect(service.payout).toHaveBeenCalledWith({ returnId: RETURN_ID, action });
  });

  it('I1: forwards a valid reprint', async () => {
    const { invoke, service } = setup();
    await invoke(RETURNS_IPC_CHANNELS.REPRINT_SLIP, { returnId: RETURN_ID });
    expect(service.reprintSlip).toHaveBeenCalledWith({ returnId: RETURN_ID });
  });

  it.each<[string, unknown]>([
    ['no payload', undefined],
    ['null', null],
    ['an array', [RETURN_ID, 'start']],
    ['a missing action', { returnId: RETURN_ID }],
    ['an unknown action', { returnId: RETURN_ID, action: 'refund_card' }],
    ['a non-UUID id', { returnId: 'ret-1', action: 'start' }],
    ['a numeric id', { returnId: 42, action: 'start' }],
    ['M1: an amount', { returnId: RETURN_ID, action: 'start', amountMinor: 1 }],
    ['an operator', { returnId: RETURN_ID, action: 'manual', operatorId: 'op-x' }],
    ['a method', { returnId: RETURN_ID, action: 'start', method: 'manual' }],
  ])('I1: refuses a payout with %s', async (_label, payload) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.PAYOUT, payload)).resolves.toEqual(INVALID_PAYOUT);
    expect(service.payout).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['no payload', undefined],
    ['a non-UUID id', { returnId: 'x' }],
    ['an extra key', { returnId: RETURN_ID, copy: false }],
  ])('I1: refuses a reprint with %s', async (_label, payload) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.REPRINT_SLIP, payload)).resolves.toEqual(INVALID);
    expect(service.reprintSlip).not.toHaveBeenCalled();
  });
});
