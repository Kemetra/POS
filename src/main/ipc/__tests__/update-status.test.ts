/**
 * RT-322 (S-B) — `updateStatus:get` IPC registration, the status sanitizer and
 * the change push. Only a closed-set state, a plain version, closed-set
 * blockers and a short machine code ever leave main.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  registerUpdateStatusHandlers,
  sanitizeUpdateStatus,
  wireUpdateStatusPush,
} from '../update-status.js';
import {
  UPDATE_STATUS_INVALID,
  UPDATE_STATUS_IPC_CHANNELS,
  UPDATE_STATUS_STATES,
  type UpdateStatusSnapshot,
} from '../../../shared/update-status/types.js';
import { UPDATE_STATES, type UpdateStatus } from '../../update/update-types.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (...args: unknown[]) => unknown;
  names: string[];
} {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, fn: Handler) {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return {
    ipcMain,
    names: [],
    invoke: (...args) => {
      const fn = handlers.get(UPDATE_STATUS_IPC_CHANNELS.GET);
      if (!fn) throw new Error('no handler');
      return fn({} as IpcMainInvokeEvent, ...args);
    },
  };
}

describe('update-status vocabulary', () => {
  it('mirrors the main-process state set', () => {
    expect([...UPDATE_STATUS_STATES]).toEqual([...UPDATE_STATES]);
  });
});

describe('sanitizeUpdateStatus', () => {
  it('passes the state and a plain version through', () => {
    expect(sanitizeUpdateStatus({ state: 'downloaded', availableVersion: '1.4.2' })).toEqual({
      v: 1,
      state: 'downloaded',
      availableVersion: '1.4.2',
    });
  });

  it('never sends detail or blockers', () => {
    expect(
      sanitizeUpdateStatus({
        state: 'update_pending',
        detail: 'publisher_not_pinned',
        blockers: ['open_shift'],
      }),
    ).toEqual({ v: 1, state: 'update_pending' });
  });

  it.each([
    'file:///C:/x',
    '1.4.2 https://evil.test',
    '../../1.0.0',
    'latest',
    '1.4',
    String.raw`C:\Users\cashier\x.exe`,
  ])('drops a version that is not plain: %s', (availableVersion) => {
    expect(sanitizeUpdateStatus({ state: 'downloaded', availableVersion })).toEqual({
      v: 1,
      state: 'downloaded',
    });
  });

  it('never forwards a field it does not know', () => {
    const raw = {
      state: 'error',
      detail: 'Cannot fetch https://updates.example.test/x at C:\\app\\x.js',
      origin: 'https://updates.example.test',
      channel: 'lab',
      stack: 'at x',
    } as unknown as UpdateStatus;
    expect(sanitizeUpdateStatus(raw)).toEqual({ v: 1, state: 'error' });
  });

  it('answers an unknown state as error, never as a healthy one', () => {
    expect(sanitizeUpdateStatus({ state: 'bogus' as never })).toEqual({ v: 1, state: 'error' });
  });

  it('answers idle truthfully when the service is disabled', () => {
    expect(sanitizeUpdateStatus({ state: 'idle' })).toEqual({ v: 1, state: 'idle' });
  });
});

describe('registerUpdateStatusHandlers', () => {
  it('answers `{}` with the sanitized current status', () => {
    const { ipcMain, invoke } = fakeIpcMain();
    registerUpdateStatusHandlers(ipcMain, {
      read: () => ({ state: 'downloaded', availableVersion: '2.0.0', detail: 'C:\\x' }),
    });
    expect(invoke({})).toEqual({ v: 1, state: 'downloaded', availableVersion: '2.0.0' });
  });

  it.each([
    ['no argument', []],
    ['a key', [{ channel: 'stable' }]],
    ['a string', ['stable']],
    ['null', [null]],
    ['an array', [[]]],
    ['an extra argument', [{}, {}]],
  ])('refuses %s without reading the status', (_label, args) => {
    const { ipcMain, invoke } = fakeIpcMain();
    const read = vi.fn(() => ({ state: 'idle' as const }));
    registerUpdateStatusHandlers(ipcMain, { read });
    expect(invoke(...args)).toEqual(UPDATE_STATUS_INVALID);
    expect(read).not.toHaveBeenCalled();
  });

  it('registers exactly one channel, the read-only getter', () => {
    const channels: string[] = [];
    const ipcMain = {
      handle: (c: string) => channels.push(c),
      on: (c: string) => channels.push(c),
    } as unknown as IpcMain;
    registerUpdateStatusHandlers(ipcMain, { read: () => ({ state: 'idle' }) });
    expect(channels).toEqual([UPDATE_STATUS_IPC_CHANNELS.GET]);
  });
});

describe('wireUpdateStatusPush', () => {
  it('sends each distinct sanitized status once and stops on unsubscribe', () => {
    const listeners: Array<(s: UpdateStatus) => void> = [];
    const unsubscribe = vi.fn();
    const sent: UpdateStatusSnapshot[] = [];
    const stop = wireUpdateStatusPush({
      subscribe: (l) => {
        listeners.push(l);
        return unsubscribe;
      },
      send: (s) => {
        sent.push(s);
      },
    });
    const emit = (s: UpdateStatus): void => {
      for (const l of listeners) l(s);
    };
    emit({ state: 'downloaded', availableVersion: '2.0.0' });
    emit({ state: 'downloaded', availableVersion: '2.0.0' });
    emit({ state: 'update_pending', availableVersion: '2.0.0' });
    expect(sent).toEqual([
      { v: 1, state: 'downloaded', availableVersion: '2.0.0' },
      { v: 1, state: 'update_pending', availableVersion: '2.0.0' },
    ]);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing send break the service', () => {
    const listeners: Array<(s: UpdateStatus) => void> = [];
    wireUpdateStatusPush({
      subscribe: (l) => {
        listeners.push(l);
        return () => undefined;
      },
      send: () => {
        throw new Error('window closed');
      },
    });
    expect(() => {
      for (const l of listeners) l({ state: 'error', detail: 'x' });
    }).not.toThrow();
  });
});
