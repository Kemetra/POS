import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerCashierPinStatusHandler } from '../cashier-pin-status.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import { OPERATOR_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type { ListCashierPinStatusResponse } from '../../../shared/bridge-api.js';

/**
 * RT-424 (D-M1) — `operator:list-cashier-pin-status` IPC boundary (§A4): the
 * renderer passes nothing (any argument is ignored — scope is main-side), a
 * throw never crosses the bridge, and the channel is refused while locked.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): {
  ipcMain: Pick<IpcMain, 'handle'>;
  invoke: (c: string, ...a: unknown[]) => unknown;
} {
  const handlers = new Map<string, Listener>();
  return {
    ipcMain: {
      handle: (c: string, l: Listener) => {
        handlers.set(c, l);
      },
    },
    invoke: (c, ...a) => handlers.get(c)?.({} as IpcMainInvokeEvent, ...a),
  };
}

const LISTED: ListCashierPinStatusResponse = {
  kind: 'cashiers',
  cashiers: [{ id: 'op-a', display_name: 'Amal', pin: 'no_pin' }],
};

describe('RT-424 registerCashierPinStatusHandler', () => {
  it('calls the handler with no arguments, whatever the renderer sends', async () => {
    const fake = fakeIpcMain();
    const listCashierPinStatus = vi.fn(() => Promise.resolve(LISTED));
    registerCashierPinStatusHandler(fake.ipcMain, {
      cashierPinStatusHandler: { listCashierPinStatus },
    });

    await expect(
      fake.invoke(OPERATOR_IPC_CHANNELS.LIST_CASHIER_PIN_STATUS, {
        tenant_id: 'forged',
        terminal_id: 'forged',
      }),
    ).resolves.toEqual(LISTED);
    expect(listCashierPinStatus).toHaveBeenCalledWith();
  });

  it('a throwing handler → invalid_input, nothing thrown across the bridge', async () => {
    const fake = fakeIpcMain();
    registerCashierPinStatusHandler(fake.ipcMain, {
      cashierPinStatusHandler: {
        listCashierPinStatus: () => Promise.reject(new Error('boom: secret')),
      },
    });
    await expect(fake.invoke(OPERATOR_IPC_CHANNELS.LIST_CASHIER_PIN_STATUS)).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
  });
});

describe('RT-424 operator:list-cashier-pin-status behind the session lock guard', () => {
  it('is not on the locked-session allowlist', () => {
    expect(LOCKED_ALLOWED_CHANNELS.has(OPERATOR_IPC_CHANNELS.LIST_CASHIER_PIN_STATUS)).toBe(false);
  });

  it('is refused while the session is locked and never runs the handler', async () => {
    const fake = fakeIpcMain();
    const listCashierPinStatus = vi.fn();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain as IpcMain, () => true);
    registerCashierPinStatusHandler(guarded, { cashierPinStatusHandler: { listCashierPinStatus } });

    await expect(fake.invoke(OPERATOR_IPC_CHANNELS.LIST_CASHIER_PIN_STATUS)).rejects.toBeInstanceOf(
      SessionLockedError,
    );
    expect(listCashierPinStatus).not.toHaveBeenCalled();
  });
});
