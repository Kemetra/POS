import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerCashierPinStatusHandler } from '../cashier-pin-status.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import { CASHIER_PIN_STATUS_IPC_CHANNELS } from '../../../shared/operator/channels.js';
import type { ListCashierPinStatusResponse } from '../../../shared/bridge-api.js';

/**
 * RT-424 — `operator:list-cashier-pin-status` IPC boundary (§A4): no renderer
 * argument reaches the handler, a throw never crosses the bridge, and the
 * channel is refused while the session is locked.
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

const LIST = CASHIER_PIN_STATUS_IPC_CHANNELS.LIST;
const ANSWER: ListCashierPinStatusResponse = {
  kind: 'cashiers',
  cashiers: [{ id: 'user_clerk_A', display_name: 'A', pin: 'ready' }],
};

describe('RT-424 registerCashierPinStatusHandler', () => {
  it('uses the documented channel name', () => {
    expect(LIST).toBe('operator:list-cashier-pin-status');
  });

  it('calls the handler with no arguments and ignores a forged payload', async () => {
    const fake = fakeIpcMain();
    const listCashierPinStatus = vi.fn(() => Promise.resolve(ANSWER));
    registerCashierPinStatusHandler(fake.ipcMain, {
      cashierPinStatusHandler: { listCashierPinStatus },
    });

    await expect(
      fake.invoke(LIST, { tenant_id: 'forged', terminal_id: 'forged' }),
    ).resolves.toEqual(ANSWER);
    expect(listCashierPinStatus).toHaveBeenCalledWith();
  });

  it('a throwing handler → invalid_input, nothing thrown across the bridge', async () => {
    const fake = fakeIpcMain();
    const warn = vi.fn();
    registerCashierPinStatusHandler(fake.ipcMain, {
      cashierPinStatusHandler: {
        listCashierPinStatus: () => Promise.reject(new TypeError('boom: user-neutral-secret')),
      },
      logger: { warn },
    });
    await expect(fake.invoke(LIST)).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    expect(warn).toHaveBeenCalledWith(
      { event: 'operator.cashier_pin_status.failed', err_name: 'TypeError' },
      'cashier pin status failed',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-neutral-secret');
  });
});

describe('RT-424 registerCashierPinStatusHandler — a non-Error rejection', () => {
  it('logs the value type, never the value, and answers invalid_input', async () => {
    const fake = fakeIpcMain();
    const warn = vi.fn();
    registerCashierPinStatusHandler(fake.ipcMain, {
      cashierPinStatusHandler: {
        // A plain object, not an Error (a non-Error rejection reaches the catch too).
        listCashierPinStatus: () =>
          Promise.reject(
            Object.assign(Object.create(null) as Error, { secret: 'user-neutral-secret' }),
          ),
      },
      logger: { warn },
    });
    await expect(fake.invoke(LIST)).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
    expect(warn).toHaveBeenCalledWith(
      { event: 'operator.cashier_pin_status.failed', err_name: 'object' },
      'cashier pin status failed',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-neutral-secret');
  });

  it('answers invalid_input without a logger too', async () => {
    const fake = fakeIpcMain();
    registerCashierPinStatusHandler(fake.ipcMain, {
      cashierPinStatusHandler: { listCashierPinStatus: () => Promise.reject(new Error('x')) },
    });
    await expect(fake.invoke(LIST)).resolves.toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
  });
});

describe('RT-424 operator:list-cashier-pin-status behind the session lock guard', () => {
  it('is not on the locked-session allowlist', () => {
    expect(LOCKED_ALLOWED_CHANNELS.has(LIST)).toBe(false);
  });

  it('is refused while the session is locked and never runs the handler', async () => {
    const fake = fakeIpcMain();
    const listCashierPinStatus = vi.fn();
    const guarded = createSessionLockGuardedIpcMain(fake.ipcMain as IpcMain, () => true);
    registerCashierPinStatusHandler(guarded, {
      cashierPinStatusHandler: { listCashierPinStatus },
    });

    await expect(fake.invoke(LIST)).rejects.toBeInstanceOf(SessionLockedError);
    expect(listCashierPinStatus).not.toHaveBeenCalled();
  });
});
